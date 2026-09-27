//! プロジェクトツリー SQLite のバックアップ、検証、内容比較を管理する。

use std::{fs, path::Path, time::Duration};

use rusqlite::{backup::Backup, types::Value, Connection, OpenFlags};

use super::migration::install_temporary_file;
use super::paths::temporary_path;

/// SQLite Backup API を使い、複製後に integrity_check を通す。
pub(super) fn backup_database(source: &Path, temporary_target: &Path) -> Result<(), String> {
    let source_connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("SQLite 移行元を開けません: {error}"))?;
    let mut target_connection = Connection::open(temporary_target)
        .map_err(|error| format!("SQLite 一時 DB を作成できません: {error}"))?;
    {
        let backup = Backup::new(&source_connection, &mut target_connection)
            .map_err(|error| format!("SQLite バックアップを開始できません: {error}"))?;
        backup
            .run_to_completion(64, Duration::from_millis(5), None)
            .map_err(|error| format!("SQLite をバックアップできません: {error}"))?;
    }
    let integrity: String = target_connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("SQLite 移行先を検証できません: {error}"))?;
    if integrity != "ok" {
        return Err(format!(
            "SQLite 移行先の整合性検査に失敗しました: {integrity}"
        ));
    }
    drop(target_connection);
    drop(source_connection);
    Ok(())
}

/// 保存先の初回起動では空 DB を原子的に準備し、再起動時も安全に再利用できるようにする。
pub(super) fn ensure_project_tree_database(database_path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(database_path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            crate::project_tree::validate_database_file(database_path)
        }
        Ok(_) => Err(format!(
            "プロジェクトツリー DB が通常ファイルではありません: {}",
            database_path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let temporary_path = temporary_path(database_path, "new-database");
            if let Err(error) = crate::project_tree::prepare_new_database_file(&temporary_path) {
                let _ = fs::remove_file(&temporary_path);
                return Err(error);
            }
            if let Err(error) = install_temporary_file(&temporary_path, database_path) {
                let _ = fs::remove_file(&temporary_path);
                if crate::project_tree::is_empty_database_file(database_path).unwrap_or(false) {
                    return Ok(());
                }
                return Err(error);
            }
            crate::project_tree::validate_database_file(database_path)
        }
        Err(error) => Err(format!(
            "プロジェクトツリー DB を確認できません ({}): {error}",
            database_path.display()
        )),
    }
}

/// SQLite のスキーマとテーブル内容が一致するか調べ、中断移行の同一 DB を判定する。
pub(super) fn sqlite_contents_match(source: &Path, target: &Path) -> Result<bool, String> {
    let source_connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("SQLite 移行元を開けません: {error}"))?;
    let target_connection = Connection::open_with_flags(target, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("SQLite 移行先を開けません: {error}"))?;
    let source_integrity = integrity_check(&source_connection)?;
    let target_integrity = integrity_check(&target_connection)?;
    if source_integrity != "ok" || target_integrity != "ok" {
        return Ok(false);
    }
    Ok(database_contents(&source_connection)? == database_contents(&target_connection)?)
}

/// SQLite の論理内容を、表定義・全行・autoincrement 状態の順に取得する。
fn database_contents(connection: &Connection) -> Result<DatabaseContents, String> {
    let mut object_statement = connection
        .prepare(
            "SELECT type, name, sql FROM sqlite_master
             WHERE type IN ('table', 'index', 'trigger', 'view')
               AND name NOT LIKE 'sqlite_%'
             ORDER BY type, name",
        )
        .map_err(|error| format!("SQLite スキーマを読み込めません: {error}"))?;
    let objects = object_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| format!("SQLite スキーマを取得できません: {error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("SQLite スキーマを読み込めません: {error}"))?;

    let mut tables = Vec::new();
    for (kind, name, _) in &objects {
        if kind != "table" {
            continue;
        }
        let escaped_name = name.replace('"', "\"\"");
        let mut statement = connection
            .prepare(&format!("SELECT * FROM \"{escaped_name}\" ORDER BY rowid"))
            .map_err(|error| format!("SQLite テーブルを読み込めません ({name}): {error}"))?;
        let column_count = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                (0..column_count)
                    .map(|index| row.get::<_, Value>(index))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|error| format!("SQLite テーブルを取得できません ({name}): {error}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("SQLite テーブルを読み込めません ({name}): {error}"))?;
        tables.push((name.clone(), rows));
    }

    let sequence = match connection.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name") {
        Ok(mut statement) => statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| format!("SQLite ID 採番状態を取得できません: {error}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("SQLite ID 採番状態を読み込めません: {error}"))?,
        Err(rusqlite::Error::SqliteFailure(error, _))
            if error.code == rusqlite::ErrorCode::Unknown =>
        {
            Vec::new()
        }
        Err(error) => return Err(format!("SQLite ID 採番状態を確認できません: {error}")),
    };

    Ok(DatabaseContents {
        objects,
        tables,
        sequence,
    })
}

/// DB が読み取り可能で整合しているかを調べる。
fn integrity_check(connection: &Connection) -> Result<String, String> {
    connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("SQLite 整合性を検査できません: {error}"))
}

#[derive(Debug, PartialEq)]
struct DatabaseContents {
    objects: Vec<(String, String, Option<String>)>,
    tables: Vec<(String, Vec<Vec<Value>>)>,
    sequence: Vec<(String, i64)>,
}

#[cfg(test)]
mod tests {
    use super::super::paths::PROJECT_TREE_FILE;
    use super::super::test_support::TestDirectory;
    use super::*;
    use rusqlite::{params, Connection};
    use std::path::Path;

    /// DB の移行結果を検証するため、小さく識別可能なテーブルを作る。
    fn create_test_database(path: &Path) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE documents(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
                 CREATE INDEX documents_name ON documents(name);
                 INSERT INTO documents(name) VALUES ('first'), ('second');",
            )
            .unwrap();
        connection
            .execute("DELETE FROM documents WHERE id = 2", [])
            .unwrap();
        connection
            .execute("INSERT INTO documents(name) VALUES (?1)", params!["third"])
            .unwrap();
    }

    /// DB は通常接続を開く前に Backup API で複製され、論理内容が保たれる。
    #[test]
    fn sqlite_backup_preserves_database_contents() {
        let test_directory = TestDirectory::new();
        let source = test_directory.path().join(PROJECT_TREE_FILE);
        let target = test_directory.path().join("copied.sqlite3");
        create_test_database(&source);

        backup_database(&source, &target).unwrap();

        assert!(sqlite_contents_match(&source, &target).unwrap());
    }
}
