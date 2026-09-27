//! プロジェクトツリーのノード操作とファイル参照管理を担当する。

use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use tauri::Window;
use tauri_plugin_fs::FsExt;

use super::{
    database::{database_error, lock_connection},
    ordering::{insert_ordered_node, move_node_in_transaction},
    projects::{normalized_name, validate_project},
    ProjectTreeState,
};

/// 同じプロジェクトに属する仮想フォルダを親として検証する。
pub(super) fn validate_parent(
    transaction: &Transaction<'_>,
    project_id: i64,
    parent_id: Option<i64>,
) -> Result<(), String> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    let kind: Option<String> = transaction
        .query_row(
            "SELECT kind FROM project_nodes WHERE id = ?1 AND project_id = ?2",
            params![parent_id, project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| database_error("親フォルダを確認できません", error))?;
    match kind.as_deref() {
        Some("folder") => Ok(()),
        Some(_) => Err("ファイルの中には項目を作成できません".to_string()),
        None => Err("親フォルダが見つかりません".to_string()),
    }
}

/// ツリー登録用 TXT パスがアプリ管理の FS Scope に含まれ、実在する通常ファイルか検証する。
pub(super) fn validated_file_path(
    window: &Window,
    path: String,
) -> Result<(PathBuf, String), String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("絶対パスのファイルを指定してください".to_string());
    }
    if !window.fs_scope().is_allowed(&path) {
        return Err("このファイルはアプリの許可範囲にありません。選択またはドロップしてから再試行してください".to_string());
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("参照先ファイルを確認できません: {error}"))?;
    if !metadata.is_file() {
        return Err("通常ファイルを選択してください".to_string());
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("txt"))
    {
        return Err("TXT ファイルを選択してください".to_string());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "ファイル名を取得できません".to_string())?
        .to_string();
    Ok((path, name))
}

/// トランザクション内で、同一プロジェクトのノード登録だけを一括削除する。
pub(super) fn remove_project_nodes_in_transaction(
    transaction: &Transaction<'_>,
    node_ids: &[i64],
) -> Result<(), String> {
    if node_ids.is_empty() {
        return Err("削除対象ノードがありません".to_string());
    }

    let mut unique_node_ids = Vec::with_capacity(node_ids.len());
    for node_id in node_ids {
        if !unique_node_ids.contains(node_id) {
            unique_node_ids.push(*node_id);
        }
    }

    let mut project_id = None;
    for node_id in &unique_node_ids {
        let node_project_id = transaction
            .query_row(
                "SELECT project_id FROM project_nodes WHERE id = ?1",
                params![node_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| database_error("削除対象ノードを確認できません", error))?
            .ok_or_else(|| "削除対象ノードが見つかりません".to_string())?;
        if let Some(expected_project_id) = project_id {
            if expected_project_id != node_project_id {
                return Err("別のプロジェクトのノードを同時に削除できません".to_string());
            }
        } else {
            project_id = Some(node_project_id);
        }
    }

    for node_id in unique_node_ids {
        transaction
            .execute("DELETE FROM project_nodes WHERE id = ?1", params![node_id])
            .map_err(|error| database_error("ツリーノードを削除できません", error))?;
    }
    Ok(())
}

/// 指定階層に仮想フォルダを追加する。
pub(super) fn create_folder(
    state: &ProjectTreeState,
    project_id: i64,
    parent_id: Option<i64>,
    name: String,
) -> Result<(), String> {
    let name = normalized_name(name)?;
    let mut guard = lock_connection(state)?;
    let connection = guard
        .as_mut()
        .expect("lock_connection checked initialization");
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("フォルダを作成できません", error))?;
    validate_project(&transaction, project_id)?;
    validate_parent(&transaction, project_id, parent_id)?;
    insert_ordered_node(&transaction, project_id, parent_id, "folder", &name, None)?;
    transaction
        .commit()
        .map_err(|error| database_error("フォルダ作成を確定できません", error))
}
/// 仮想フォルダの表示名を変更する。
pub(super) fn rename_folder(
    state: &ProjectTreeState,
    node_id: i64,
    name: String,
) -> Result<(), String> {
    let name = normalized_name(name)?;
    let guard = lock_connection(state)?;
    let connection = guard
        .as_ref()
        .expect("lock_connection checked initialization");
    let changed = connection
        .execute(
            "UPDATE project_nodes SET name = ?1 WHERE id = ?2 AND kind = 'folder'",
            params![name, node_id],
        )
        .map_err(|error| database_error("フォルダ名を変更できません", error))?;
    if changed == 0 {
        return Err("フォルダが見つかりません".to_string());
    }
    Ok(())
}
/// ダイアログまたはOSからのドロップで受け取った TXT をツリーへ独立した参照として登録する。
pub(super) fn register_file(
    state: &ProjectTreeState,
    window: Window,
    project_id: i64,
    parent_id: Option<i64>,
    path: String,
) -> Result<(), String> {
    let (path, name) = validated_file_path(&window, path)?;
    let path = path.to_string_lossy().into_owned();
    let mut guard = lock_connection(state)?;
    let connection = guard
        .as_mut()
        .expect("lock_connection checked initialization");
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("ファイルを登録できません", error))?;
    validate_project(&transaction, project_id)?;
    validate_parent(&transaction, project_id, parent_id)?;
    insert_ordered_node(
        &transaction,
        project_id,
        parent_id,
        "file",
        &name,
        Some(&path),
    )?;
    transaction
        .commit()
        .map_err(|error| database_error("ファイル登録を確定できません", error))
}
/// 既存のファイル参照を、ダイアログで選択した TXT に付け替える。
pub(super) fn relink_file(
    state: &ProjectTreeState,
    window: Window,
    node_id: i64,
    path: String,
) -> Result<(), String> {
    let (path, name) = validated_file_path(&window, path)?;
    let path = path.to_string_lossy().into_owned();
    let guard = lock_connection(state)?;
    let connection = guard
        .as_ref()
        .expect("lock_connection checked initialization");
    let changed = connection
        .execute(
            "UPDATE project_nodes SET path = ?1, name = ?2 WHERE id = ?3 AND kind = 'file'",
            params![path, name, node_id],
        )
        .map_err(|error| database_error("参照先を変更できません", error))?;
    if changed == 0 {
        return Err("ファイルノードが見つかりません".to_string());
    }
    Ok(())
}
/// ノード登録だけを一括削除し、実ファイルには触れない。
pub(super) fn remove_nodes(state: &ProjectTreeState, node_ids: Vec<i64>) -> Result<(), String> {
    let mut guard = lock_connection(state)?;
    let connection = guard
        .as_mut()
        .expect("lock_connection checked initialization");
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("ツリーノード削除を開始できません", error))?;
    remove_project_nodes_in_transaction(&transaction, &node_ids)?;
    transaction
        .commit()
        .map_err(|error| database_error("ツリーノード削除を確定できません", error))
}
/// ノードを同一プロジェクト内で並べ替え、必要な場合だけ移動先兄弟を再採番する。
pub(super) fn move_node(
    state: &ProjectTreeState,
    node_id: i64,
    target_id: Option<i64>,
    placement: String,
) -> Result<(), String> {
    let mut guard = lock_connection(state)?;
    let connection = guard
        .as_mut()
        .expect("lock_connection checked initialization");
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("ノードを移動できません", error))?;
    move_node_in_transaction(&transaction, node_id, target_id, &placement)?;
    transaction
        .commit()
        .map_err(|error| database_error("ノード移動を確定できません", error))
}
/// 保存済みノードの参照先を検証し、アプリ管理の FS Scope へ追加する。
pub(super) fn authorize_file(
    state: &ProjectTreeState,
    window: Window,
    node_id: i64,
) -> Result<String, String> {
    let guard = lock_connection(state)?;
    let connection = guard
        .as_ref()
        .expect("lock_connection checked initialization");
    let path: Option<String> = connection
        .query_row(
            "SELECT path FROM project_nodes WHERE id = ?1 AND kind = 'file'",
            params![node_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| database_error("登録ファイルを取得できません", error))?
        .ok_or_else(|| "ファイルノードが見つかりません".to_string())?;
    let path = path.ok_or_else(|| "登録ファイルの参照先がありません".to_string())?;
    let file_path = Path::new(&path);
    let metadata = std::fs::metadata(file_path)
        .map_err(|error| format!("参照先ファイルが見つかりません: {error}"))?;
    if !metadata.is_file() {
        return Err("参照先が通常ファイルではありません".to_string());
    }
    window
        .fs_scope()
        .allow_file(file_path)
        .map_err(|error| format!("ファイルの読み書きを許可できません: {error}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};

    use super::super::ordering::insert_ordered_node;
    use super::remove_project_nodes_in_transaction;

    /// 本番と同じ制約を持つインメモリ DB を作る。
    fn memory_database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .unwrap();
        super::super::database::create_schema(&connection).unwrap();
        connection
    }

    /// テスト用プロジェクトを作る。
    fn create_project(connection: &Connection) -> i64 {
        connection
            .execute("INSERT INTO projects(name) VALUES ('test')", [])
            .unwrap();
        connection.last_insert_rowid()
    }

    #[test]
    fn same_file_can_be_registered_more_than_once_in_one_project() {
        let mut connection = memory_database();
        let project_id = create_project(&connection);
        let transaction = connection.transaction().unwrap();
        insert_ordered_node(
            &transaction,
            project_id,
            None,
            "file",
            "same.txt",
            Some("C:/writing/same.txt"),
        )
        .unwrap();
        insert_ordered_node(
            &transaction,
            project_id,
            None,
            "file",
            "same.txt",
            Some("C:/writing/same.txt"),
        )
        .unwrap();
        transaction.commit().unwrap();

        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM project_nodes WHERE project_id = ?1 AND path = ?2",
                params![project_id, "C:/writing/same.txt"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    /// 親子ノードを含む複数削除は一つのトランザクションで完了し、他プロジェクトには触れない。
    #[test]
    fn removing_multiple_nodes_cascades_selected_children() {
        let mut connection = memory_database();
        let project_id = create_project(&connection);
        let other_project_id = create_project(&connection);
        let transaction = connection.transaction().unwrap();
        let parent =
            insert_ordered_node(&transaction, project_id, None, "folder", "parent", None).unwrap();
        let child = insert_ordered_node(
            &transaction,
            project_id,
            Some(parent),
            "file",
            "child.txt",
            Some("C:/child.txt"),
        )
        .unwrap();
        let other = insert_ordered_node(
            &transaction,
            other_project_id,
            None,
            "file",
            "other.txt",
            Some("C:/other.txt"),
        )
        .unwrap();
        remove_project_nodes_in_transaction(&transaction, &[parent, child]).unwrap();
        transaction.commit().unwrap();

        let remaining: i64 = connection
            .query_row(
                "SELECT count(*) FROM project_nodes WHERE id IN (?1, ?2, ?3)",
                params![parent, child, other],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 1);
        assert!(
            connection
                .query_row(
                    "SELECT count(*) FROM project_nodes WHERE id = ?1",
                    params![other],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
                == 1
        );
    }

    /// 存在しないIDや別プロジェクトの混在は削除前に拒否し、部分削除を起こさない。
    #[test]
    fn removing_nodes_rejects_missing_or_cross_project_ids() {
        let mut connection = memory_database();
        let first_project = create_project(&connection);
        let second_project = create_project(&connection);
        let transaction = connection.transaction().unwrap();
        let first = insert_ordered_node(
            &transaction,
            first_project,
            None,
            "file",
            "first.txt",
            Some("C:/first.txt"),
        )
        .unwrap();
        let second = insert_ordered_node(
            &transaction,
            second_project,
            None,
            "file",
            "second.txt",
            Some("C:/second.txt"),
        )
        .unwrap();
        transaction.commit().unwrap();

        let transaction = connection.transaction().unwrap();
        assert!(remove_project_nodes_in_transaction(&transaction, &[first, second]).is_err());
        transaction.rollback().unwrap();
        let transaction = connection.transaction().unwrap();
        assert!(remove_project_nodes_in_transaction(&transaction, &[first, 999_999]).is_err());
        transaction.rollback().unwrap();

        let count: i64 = connection
            .query_row("SELECT count(*) FROM project_nodes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }
}
