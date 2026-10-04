//! プロジェクトツリー DB の作成、検証、接続管理を担当する。

use std::{
    path::{Path, PathBuf},
    sync::MutexGuard,
};

use super::ProjectTreeState;
use rusqlite::{Connection, OpenFlags};

/// 保存先移行前に新規 DB のスキーマを準備する。
pub(crate) fn prepare_new_database_file(database_path: &Path) -> Result<(), String> {
    let parent = database_path
        .parent()
        .ok_or_else(|| "プロジェクトツリー DB の保存先が不正です".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("プロジェクトツリー保存先を作成できません: {error}"))?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(database_path)
        .map_err(|error| format!("新しいプロジェクトツリー DB を作成できません: {error}"))?;

    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(|error| format!("新しいプロジェクトツリー DB を作成できません: {error}"))?;
    create_schema(&connection)
        .map_err(|error| format!("新しいプロジェクトツリー DB を初期化できません: {error}"))?;
    drop(connection);
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(database_path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("新しいプロジェクトツリー DB を同期できません: {error}"))?;
    Ok(())
}

/// 既存 DB の整合性とアプリが必要とする列を読み取り専用で検証する。
pub(crate) fn validate_database_file(database_path: &Path) -> Result<(), String> {
    let connection = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| {
        format!("プロジェクトツリー DB を読み取り専用で開けません: {error}")
    })?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("プロジェクトツリー DB の整合性を確認できません: {error}"))?;
    if integrity != "ok" {
        return Err(format!(
            "プロジェクトツリー DB の整合性検査に失敗しました: {integrity}"
        ));
    }
    validate_project_tree_schema(&connection)?;
    validate_project_tree_data(&connection)
}

/// 新規移行の再開に使える空DBか確認する。履歴やGit管理登録だけのDBも保護する。
pub(crate) fn is_empty_database_file(database_path: &Path) -> Result<bool, String> {
    let connection = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("移行先 DB を読み取り専用で開けません: {error}"))?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("移行先 DB の整合性を確認できません: {error}"))?;
    if integrity != "ok"
        || validate_project_tree_schema(&connection).is_err()
        || validate_project_tree_data(&connection).is_err()
    {
        return Ok(false);
    }

    let project_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .map_err(|error| format!("移行先 DB のプロジェクトを確認できません: {error}"))?;
    let node_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM project_nodes", [], |row| row.get(0))
        .map_err(|error| format!("移行先 DB のノードを確認できません: {error}"))?;
    let state_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM project_tree_state
             WHERE singleton = 1 AND active_project_id IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("移行先 DB の選択状態を確認できません: {error}"))?;
    let recent_count = if connection
        .table_exists(None, "recent_files")
        .map_err(|error| database_error("履歴テーブルを確認できません", error))?
    {
        connection
            .query_row("SELECT COUNT(*) FROM recent_files", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| database_error("履歴を確認できません", error))?
    } else {
        0
    };
    let git_count: i64 = if connection
        .table_exists(None, "git_workspaces")
        .map_err(|e| e.to_string())?
    {
        connection
            .query_row("SELECT COUNT(*) FROM git_workspaces", [], |r| r.get(0))
            .map_err(|e| e.to_string())?
    } else {
        0
    };
    Ok(project_count == 0
        && node_count == 0
        && state_count == 1
        && recent_count == 0
        && git_count == 0)
}

/// ツリー・履歴・Git管理の形式を読み取り専用で検査し、旧DBの追加テーブル欠損は許容する。
fn validate_project_tree_schema(connection: &Connection) -> Result<(), String> {
    if connection
        .table_exists(None, "git_workspaces")
        .map_err(|e| e.to_string())?
    {
        connection
            .prepare(
                "SELECT id, root, backup, author_name, author_email FROM git_workspaces LIMIT 0",
            )
            .map_err(|e| format!("Git 管理テーブルが不正です: {e}"))?;
    }
    // 旧DBでは履歴テーブルがなくても正常。存在する場合の不正な列構成は補修せず通知する。
    if connection
        .table_exists(None, "recent_files")
        .map_err(|error| database_error("履歴テーブルを確認できません", error))?
    {
        connection
            .prepare("SELECT id, path, path_key, last_used FROM recent_files LIMIT 0")
            .map_err(|error| database_error("履歴テーブルの形式が不正です", error))?;
    }
    for (table, required_columns) in [
        ("projects", &["id", "name"][..]),
        (
            "project_nodes",
            &[
                "id",
                "project_id",
                "parent_id",
                "kind",
                "name",
                "path",
                "sort_order",
            ][..],
        ),
        (
            "project_tree_state",
            &["singleton", "active_project_id"][..],
        ),
    ] {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .map_err(|error| format!("DB スキーマを確認できません ({table}): {error}"))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| format!("DB スキーマを読み取れません ({table}): {error}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("DB スキーマを読み取れません ({table}): {error}"))?;
        if required_columns
            .iter()
            .any(|required| !columns.iter().any(|column| column == required))
        {
            return Err(format!(
                "プロジェクトツリー DB のスキーマが対応していません ({table})"
            ));
        }
    }
    Ok(())
}

/// 外部編集などで生じた参照切れや循環を、DB を修復・変更せずに拒否する。
fn validate_project_tree_data(connection: &Connection) -> Result<(), String> {
    let foreign_key_violation = connection
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut statement| statement.exists([]))
        .map_err(|error| format!("プロジェクトツリー DB の参照整合性を確認できません: {error}"))?;
    if foreign_key_violation {
        return Err("プロジェクトツリー DB に参照先のないデータがあります".to_string());
    }

    let invalid_parent: bool = connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM project_nodes child
               LEFT JOIN project_nodes parent ON parent.id = child.parent_id
               WHERE child.parent_id IS NOT NULL
                 AND (parent.id IS NULL OR parent.project_id != child.project_id OR parent.kind != 'folder')
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("プロジェクトツリー DB の親フォルダを確認できません: {error}"))?;
    if invalid_parent {
        return Err("プロジェクトツリー DB の親フォルダが不正です".to_string());
    }

    // ルートから一度ずつたどることで、深い階層でも循環部分に入らず検出する。
    let unreachable_nodes: bool = connection
        .query_row(
            "WITH RECURSIVE reachable(id) AS (
               SELECT id FROM project_nodes WHERE parent_id IS NULL
               UNION
               SELECT child.id FROM project_nodes child
               JOIN reachable parent ON child.parent_id = parent.id
             )
             SELECT (SELECT COUNT(*) FROM reachable) != (SELECT COUNT(*) FROM project_nodes)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("プロジェクトツリー DB の階層を確認できません: {error}"))?;
    if unreachable_nodes {
        return Err("プロジェクトツリー DB のフォルダ階層が循環しています".to_string());
    }
    Ok(())
}

/// 起動時に既存DBを検証し、旧DBには履歴・Git管理テーブルを追加する。DB自体は新規作成しない。
pub(super) fn initialize_database(database_path: PathBuf) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(&database_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|error| format!("プロジェクトツリー DB を開けません: {error}"))?;
    validate_project_tree_schema(&connection)?;
    validate_project_tree_data(&connection)?;
    create_schema(&connection)
        .map_err(|error| format!("プロジェクトツリー DB を初期化できません: {error}"))?;
    Ok(connection)
}

/// DB スキーマと制約を作る。インメモリ DB からも同じ定義をテストできるよう分離する。
pub(super) fn create_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS projects (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL CHECK (length(trim(name)) > 0)
             );
             CREATE TABLE IF NOT EXISTS project_nodes (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
               parent_id INTEGER,
               kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
               name TEXT NOT NULL CHECK (length(trim(name)) > 0),
               path TEXT,
               sort_order INTEGER NOT NULL,
               UNIQUE (project_id, id),
               FOREIGN KEY (project_id, parent_id)
                 REFERENCES project_nodes(project_id, id) ON DELETE CASCADE,
               CHECK (parent_id IS NULL OR parent_id != id),
               CHECK (
                 (kind = 'folder' AND path IS NULL) OR
                 (kind = 'file' AND path IS NOT NULL)
               )
             );
             CREATE INDEX IF NOT EXISTS project_nodes_order
               ON project_nodes(project_id, parent_id, sort_order, id);
             CREATE TABLE IF NOT EXISTS project_tree_state (
               singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
               active_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL
             );
             INSERT OR IGNORE INTO project_tree_state(singleton, active_project_id)
               VALUES (1, NULL);
             CREATE TABLE IF NOT EXISTS git_workspaces (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               root TEXT NOT NULL UNIQUE COLLATE NOCASE,
               backup TEXT,
               author_name TEXT NOT NULL DEFAULT '',
               author_email TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE IF NOT EXISTS recent_files (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               path TEXT NOT NULL,
               path_key TEXT NOT NULL UNIQUE,
               last_used INTEGER NOT NULL
             );",
    )
}

/// プロジェクトツリー DB の接続をロックし、初期化失敗をコマンドエラーにする。
pub(super) fn lock_connection<'a>(
    state: &'a ProjectTreeState,
) -> Result<MutexGuard<'a, Option<Connection>>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "プロジェクトツリー DB のロックに失敗しました".to_string())?;
    if connection.is_none() {
        return Err(state
            .initialization_error
            .lock()
            .map_err(|_| "プロジェクトツリー DB の状態確認に失敗しました".to_string())?
            .clone()
            .unwrap_or_else(|| "プロジェクトツリー DB を利用できません".to_string()));
    }
    Ok(connection)
}

/// DB のエラーに操作対象を添えて表示する。
pub(super) fn database_error(context: &str, error: rusqlite::Error) -> String {
    format!("{context}: {error}")
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    static DATABASE_TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    /// 一時的なテスト DB 保存先を用意する。
    fn temporary_database_path() -> (std::path::PathBuf, std::path::PathBuf) {
        let sequence = DATABASE_TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "novel-editor-project-tree-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        (directory.join("project-tree.sqlite3"), directory)
    }

    /// 旧DBには空の履歴を追加し、履歴だけがある移行先を空DBと判定しない。
    #[test]
    fn upgrades_legacy_history_and_counts_history_in_empty_check() {
        let (database_path, directory) = temporary_database_path();
        super::prepare_new_database_file(&database_path).unwrap();
        let connection = Connection::open(&database_path).unwrap();
        connection.execute("DROP TABLE recent_files", []).unwrap();
        drop(connection);
        assert!(super::is_empty_database_file(&database_path).unwrap());
        super::validate_database_file(&database_path).unwrap();
        let connection = super::initialize_database(database_path.clone()).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM recent_files", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        connection.execute("INSERT INTO recent_files(path, path_key, last_used) VALUES ('C:/原稿.txt', 'c:/原稿.txt', 1)", []).unwrap();
        assert!(!super::is_empty_database_file(&database_path).unwrap());
        drop(connection);
        fs::remove_dir_all(directory).unwrap();
    }

    /// 新規作成を許可しない通常接続は、消えた DB を空 DB として再生成しない。
    #[test]
    fn initialization_does_not_create_a_missing_database() {
        let (database_path, test_directory) = temporary_database_path();

        let state = super::super::ProjectTreeState::initialize(Ok(database_path.clone()));

        assert!(state.initialization_error().unwrap().is_some());
        assert!(!database_path.exists());
        fs::remove_dir_all(test_directory).unwrap();
    }

    /// 未対応の SQLite を起動初期化でアプリ DB へ書き換えない。
    #[test]
    fn initialization_rejects_unrelated_sqlite_schema_without_modifying_it() {
        let (database_path, test_directory) = temporary_database_path();
        Connection::open(&database_path)
            .unwrap()
            .execute_batch("CREATE TABLE unrelated(value TEXT);")
            .unwrap();

        let state = super::super::ProjectTreeState::initialize(Ok(database_path.clone()));

        assert!(state.initialization_error().unwrap().is_some());
        let connection = Connection::open(&database_path).unwrap();
        let unrelated_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'unrelated'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let project_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unrelated_count, 1);
        assert_eq!(project_count, 0);
        drop(connection);
        fs::remove_dir_all(test_directory).unwrap();
    }

    /// SQLite の物理整合性が正常でも、参照切れや不正階層は起動・再指定前に拒否する。
    #[test]
    fn invalid_tree_data_is_rejected_without_modifying_the_database() {
        for corrupt_sql in [
            "PRAGMA foreign_keys = OFF; UPDATE project_nodes SET parent_id = 999 WHERE id = 2;",
            "PRAGMA foreign_keys = OFF; UPDATE project_nodes SET project_id = 999 WHERE id = 2;",
            "PRAGMA foreign_keys = OFF; UPDATE project_tree_state SET active_project_id = 999;",
            "UPDATE project_nodes SET parent_id = 2 WHERE id = 1;",
            "UPDATE project_nodes SET kind = 'file', path = 'C:/parent.txt' WHERE id = 1;",
        ] {
            let (database_path, test_directory) = temporary_database_path();
            super::prepare_new_database_file(&database_path).unwrap();
            let connection = Connection::open(&database_path).unwrap();
            connection
                .execute_batch(
                    "INSERT INTO projects(id, name) VALUES (1, 'test');
                 INSERT INTO project_nodes(id, project_id, parent_id, kind, name, sort_order)
                   VALUES (1, 1, NULL, 'folder', 'parent', 1), (2, 1, 1, 'folder', 'child', 2);",
                )
                .unwrap();
            connection.execute_batch(corrupt_sql).unwrap();
            assert_eq!(
                connection
                    .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
            drop(connection);
            let before = fs::read(&database_path).unwrap();

            assert!(
                super::validate_database_file(&database_path).is_err(),
                "{corrupt_sql}"
            );
            assert!(
                super::initialize_database(database_path.clone()).is_err(),
                "{corrupt_sql}"
            );
            assert!(!super::is_empty_database_file(&database_path).unwrap());
            assert_eq!(fs::read(&database_path).unwrap(), before);
            fs::remove_dir_all(test_directory).unwrap();
        }
    }

    /// 有効な階層と複数プロジェクトは既存形式のまま読み書きできる。
    #[test]
    fn valid_tree_data_remains_compatible() {
        let (database_path, test_directory) = temporary_database_path();
        super::prepare_new_database_file(&database_path).unwrap();
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute_batch(
                "INSERT INTO projects(id, name) VALUES (1, 'first'), (2, 'second');
             INSERT INTO project_nodes(id, project_id, parent_id, kind, name, path, sort_order)
               VALUES (1, 1, NULL, 'folder', 'chapter', NULL, 1),
                      (2, 1, 1, 'file', 'draft', 'C:/draft.txt', 1),
                      (3, 2, NULL, 'file', 'same draft', 'C:/draft.txt', 1);",
            )
            .unwrap();
        drop(connection);
        super::validate_database_file(&database_path).unwrap();
        drop(super::initialize_database(database_path.clone()).unwrap());
        fs::remove_dir_all(test_directory).unwrap();
    }
}
