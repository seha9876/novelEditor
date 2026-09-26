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
    validate_project_tree_schema(&connection)
}

/// 新規移行の再開に使える、データのない project-tree DB か確認する。
pub(crate) fn is_empty_database_file(database_path: &Path) -> Result<bool, String> {
    let connection = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("移行先 DB を読み取り専用で開けません: {error}"))?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("移行先 DB の整合性を確認できません: {error}"))?;
    if integrity != "ok" || validate_project_tree_schema(&connection).is_err() {
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
    Ok(project_count == 0 && node_count == 0 && state_count == 1)
}

/// project-tree が操作するテーブルと列がそろっているか読み取り専用で調べる。
fn validate_project_tree_schema(connection: &Connection) -> Result<(), String> {
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

/// 起動時に既存 DB を新規作成せず開き、必要なスキーマを準備する。
pub(super) fn initialize_database(database_path: PathBuf) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(&database_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|error| format!("プロジェクトツリー DB を開けません: {error}"))?;
    validate_project_tree_schema(&connection)?;
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
               VALUES (1, NULL);",
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
}
