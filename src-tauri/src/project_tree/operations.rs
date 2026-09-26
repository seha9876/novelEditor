//! プロジェクトツリーの検証、順位付け、トランザクション操作を担当する。

use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use tauri::Window;
use tauri_plugin_fs::FsExt;

use crate::project_order::{order_between, reindexed_order_at, PositionError};

use super::{
    database::{database_error, lock_connection},
    ProjectInfo, ProjectNodeInfo, ProjectTreeSnapshot, ProjectTreeState,
};

/// 空白だけの名前を拒否し、保存時の前後空白を取り除く。
pub(super) fn normalized_name(name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("名前を入力してください".to_string());
    }
    Ok(name)
}

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

/// 指定階層のノードを安定した順位順で取得する。
pub(super) fn ordered_siblings(
    transaction: &Transaction<'_>,
    project_id: i64,
    parent_id: Option<i64>,
    excluded_id: Option<i64>,
) -> Result<Vec<(i64, i64)>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, sort_order FROM project_nodes
             WHERE project_id = ?1 AND parent_id IS ?2 AND (?3 IS NULL OR id != ?3)
             ORDER BY sort_order ASC, id ASC",
        )
        .map_err(|error| database_error("兄弟ノードを取得できません", error))?;
    let rows = statement
        .query_map(params![project_id, parent_id, excluded_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|error| database_error("兄弟ノードを取得できません", error))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| database_error("兄弟ノードを取得できません", error))
}

/// ノード追加時に末尾へ順位を割り当て、必要ならその階層だけ再採番する。
pub(super) fn insert_ordered_node(
    transaction: &Transaction<'_>,
    project_id: i64,
    parent_id: Option<i64>,
    kind: &str,
    name: &str,
    path: Option<&str>,
) -> Result<i64, String> {
    let siblings = ordered_siblings(transaction, project_id, parent_id, None)?;
    let last_order = siblings.last().map(|(_, order)| *order);
    let order = match order_between(last_order, None) {
        Ok(order) => order,
        Err(_) => 0,
    };
    transaction
        .execute(
            "INSERT INTO project_nodes(project_id, parent_id, kind, name, path, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![project_id, parent_id, kind, name, path, order],
        )
        .map_err(|error| database_error("ツリーノードを追加できません", error))?;
    let node_id = transaction.last_insert_rowid();

    if order_between(last_order, None).is_err() {
        let mut ordered_ids = siblings.iter().map(|(id, _)| *id).collect::<Vec<_>>();
        ordered_ids.push(node_id);
        reindex_destination(transaction, project_id, parent_id, &ordered_ids)?;
    }
    Ok(node_id)
}

/// 移動後の兄弟だけに、共通間隔で順位を振り直す。
pub(super) fn reindex_destination(
    transaction: &Transaction<'_>,
    project_id: i64,
    parent_id: Option<i64>,
    ordered_ids: &[i64],
) -> Result<(), String> {
    for (index, node_id) in ordered_ids.iter().enumerate() {
        let order = reindexed_order_at(index, ordered_ids.len()).map_err(|error| match error {
            PositionError::OutOfRange => {
                "兄弟ノード数が多すぎて安全な順位を割り当てられません".to_string()
            }
            _ => "順位を再採番できません".to_string(),
        })?;
        transaction
            .execute(
                "UPDATE project_nodes SET parent_id = ?1, sort_order = ?2
                 WHERE id = ?3 AND project_id = ?4",
                params![parent_id, order, node_id, project_id],
            )
            .map_err(|error| database_error("順位を再採番できません", error))?;
    }
    Ok(())
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

/// 接続済み DB のトランザクション内で、表示対象プロジェクトを補正する。
pub(super) fn active_project_id(transaction: &Transaction<'_>) -> Result<Option<i64>, String> {
    let active: Option<i64> = transaction
        .query_row(
            "SELECT active_project_id FROM project_tree_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| database_error("選択中プロジェクトを取得できません", error))?;
    if active.is_some() {
        return Ok(active);
    }

    let first: Option<i64> = transaction
        .query_row(
            "SELECT id FROM projects ORDER BY id ASC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| database_error("プロジェクトを取得できません", error))?;
    transaction
        .execute(
            "UPDATE project_tree_state SET active_project_id = ?1 WHERE singleton = 1",
            params![first],
        )
        .map_err(|error| database_error("選択中プロジェクトを保存できません", error))?;
    Ok(first)
}

/// プロジェクトが存在することを検証する。
pub(super) fn validate_project(
    transaction: &Transaction<'_>,
    project_id: i64,
) -> Result<(), String> {
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|error| database_error("プロジェクトを確認できません", error))?;
    if exists {
        Ok(())
    } else {
        Err("プロジェクトが見つかりません".to_string())
    }
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

/// 移動するフォルダをその子孫配下へ入れないように検証する。
pub(super) fn validate_no_cycle(
    transaction: &Transaction<'_>,
    project_id: i64,
    node_id: i64,
    destination_parent_id: Option<i64>,
) -> Result<(), String> {
    let mut ancestor_id = destination_parent_id;
    while let Some(current_id) = ancestor_id {
        if current_id == node_id {
            return Err("フォルダを自分自身や配下へ移動できません".to_string());
        }
        ancestor_id = transaction
            .query_row(
                "SELECT parent_id FROM project_nodes WHERE id = ?1 AND project_id = ?2",
                params![current_id, project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| database_error("移動先の階層を確認できません", error))?
            .flatten();
    }
    Ok(())
}

/// トランザクション内でノードを移動し、再採番が発生したかを返す。
pub(super) fn move_node_in_transaction(
    transaction: &Transaction<'_>,
    node_id: i64,
    target_id: Option<i64>,
    placement: &str,
) -> Result<bool, String> {
    let moving = transaction
        .query_row(
            "SELECT project_id FROM project_nodes WHERE id = ?1",
            params![node_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| database_error("移動元ノードを取得できません", error))?
        .ok_or_else(|| "移動元ノードが見つかりません".to_string())?;
    let project_id = moving;

    let (destination_parent_id, insertion_target, append_to_end) = match placement {
        "before" | "after" => {
            let target_id = target_id.ok_or_else(|| "移動先ノードが必要です".to_string())?;
            if target_id == node_id {
                return Err("同じノードを移動先に指定できません".to_string());
            }
            let target = transaction
                .query_row(
                    "SELECT project_id, parent_id FROM project_nodes WHERE id = ?1",
                    params![target_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
                )
                .optional()
                .map_err(|error| database_error("移動先ノードを取得できません", error))?
                .ok_or_else(|| "移動先ノードが見つかりません".to_string())?;
            if target.0 != project_id {
                return Err("別のプロジェクトへノードを移動できません".to_string());
            }
            (target.1, Some(target_id), false)
        }
        "inside" => {
            let target_id = target_id.ok_or_else(|| "移動先フォルダが必要です".to_string())?;
            let target = transaction
                .query_row(
                    "SELECT project_id, kind FROM project_nodes WHERE id = ?1",
                    params![target_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|error| database_error("移動先フォルダを取得できません", error))?
                .ok_or_else(|| "移動先フォルダが見つかりません".to_string())?;
            if target.0 != project_id {
                return Err("別のプロジェクトへノードを移動できません".to_string());
            }
            if target.1 != "folder" {
                return Err("移動先には仮想フォルダを指定してください".to_string());
            }
            (Some(target_id), None, true)
        }
        "root_end" if target_id.is_none() => (None, None, true),
        "root_end" => {
            return Err("ルート末尾への移動では targetId を null にしてください".to_string())
        }
        _ => return Err("未対応のドロップ位置です".to_string()),
    };

    validate_no_cycle(&transaction, project_id, node_id, destination_parent_id)?;
    let siblings = ordered_siblings(
        &transaction,
        project_id,
        destination_parent_id,
        Some(node_id),
    )?;
    let insertion_index = if append_to_end {
        siblings.len()
    } else {
        let target_id = insertion_target.expect("before/after placement has a target");
        let target_index = siblings
            .iter()
            .position(|(sibling_id, _)| *sibling_id == target_id)
            .ok_or_else(|| "移動先ノードの階層が不正です".to_string())?;
        if placement == "before" {
            target_index
        } else {
            target_index + 1
        }
    };
    let previous_order = insertion_index
        .checked_sub(1)
        .and_then(|index| siblings.get(index))
        .map(|(_, order)| *order);
    let next_order = siblings.get(insertion_index).map(|(_, order)| *order);
    match order_between(previous_order, next_order) {
        Ok(order) => {
            transaction
                .execute(
                    "UPDATE project_nodes SET parent_id = ?1, sort_order = ?2 WHERE id = ?3",
                    params![destination_parent_id, order, node_id],
                )
                .map_err(|error| database_error("ノードを移動できません", error))?;
            Ok(false)
        }
        Err(_) => {
            let mut ordered_ids = siblings.iter().map(|(id, _)| *id).collect::<Vec<_>>();
            ordered_ids.insert(insertion_index, node_id);
            reindex_destination(transaction, project_id, destination_parent_id, &ordered_ids)?;
            Ok(true)
        }
    }
}

/// 永続化した全ツリーと選択中プロジェクトを返す。
pub(super) fn snapshot(state: &ProjectTreeState) -> Result<ProjectTreeSnapshot, String> {
    let mut guard = lock_connection(state)?;
    let connection = guard
        .as_mut()
        .expect("lock_connection checked initialization");
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("プロジェクトツリーを読めません", error))?;
    let active_project_id = active_project_id(&transaction)?;

    let mut projects_statement = transaction
        .prepare("SELECT id, name FROM projects ORDER BY id ASC")
        .map_err(|error| database_error("プロジェクトを取得できません", error))?;
    let projects = projects_statement
        .query_map([], |row| {
            Ok(ProjectInfo {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(|error| database_error("プロジェクトを取得できません", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| database_error("プロジェクトを取得できません", error))?;
    drop(projects_statement);

    let mut nodes_statement = transaction
        .prepare(
            "SELECT id, project_id, parent_id, kind, name, path FROM project_nodes
             ORDER BY project_id ASC, parent_id ASC, sort_order ASC, id ASC",
        )
        .map_err(|error| database_error("ツリーノードを取得できません", error))?;
    let nodes = nodes_statement
        .query_map([], |row| {
            Ok(ProjectNodeInfo {
                id: row.get(0)?,
                project_id: row.get(1)?,
                parent_id: row.get(2)?,
                kind: row.get(3)?,
                name: row.get(4)?,
                path: row.get(5)?,
            })
        })
        .map_err(|error| database_error("ツリーノードを取得できません", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| database_error("ツリーノードを取得できません", error))?;
    drop(nodes_statement);
    transaction
        .commit()
        .map_err(|error| database_error("プロジェクトツリーを確定できません", error))?;

    Ok(ProjectTreeSnapshot {
        projects,
        nodes,
        active_project_id,
    })
}

/// 新しいプロジェクトを作成し、初回なら選択中にもする。
pub(super) fn create_project(state: &ProjectTreeState, name: String) -> Result<(), String> {
    let name = normalized_name(name)?;
    let mut guard = lock_connection(state)?;
    let connection = guard
        .as_mut()
        .expect("lock_connection checked initialization");
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("プロジェクトを作成できません", error))?;
    transaction
        .execute("INSERT INTO projects(name) VALUES (?1)", params![name])
        .map_err(|error| database_error("プロジェクトを作成できません", error))?;
    let project_id = transaction.last_insert_rowid();
    transaction
        .execute(
            "UPDATE project_tree_state SET active_project_id = COALESCE(active_project_id, ?1)
             WHERE singleton = 1",
            params![project_id],
        )
        .map_err(|error| database_error("選択中プロジェクトを保存できません", error))?;
    transaction
        .commit()
        .map_err(|error| database_error("プロジェクトを確定できません", error))
}

/// プロジェクト名を変更する。
pub(super) fn rename_project(
    state: &ProjectTreeState,
    project_id: i64,
    name: String,
) -> Result<(), String> {
    let name = normalized_name(name)?;
    let guard = lock_connection(state)?;
    let connection = guard
        .as_ref()
        .expect("lock_connection checked initialization");
    let changed = connection
        .execute(
            "UPDATE projects SET name = ?1 WHERE id = ?2",
            params![name, project_id],
        )
        .map_err(|error| database_error("プロジェクト名を変更できません", error))?;
    if changed == 0 {
        return Err("プロジェクトが見つかりません".to_string());
    }
    Ok(())
}

/// プロジェクトとツリー登録だけを削除し、選択先を同一トランザクションで補正する。
pub(super) fn delete_project(state: &ProjectTreeState, project_id: i64) -> Result<(), String> {
    let mut guard = lock_connection(state)?;
    let connection = guard
        .as_mut()
        .expect("lock_connection checked initialization");
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("プロジェクトを削除できません", error))?;
    let active: Option<i64> = transaction
        .query_row(
            "SELECT active_project_id FROM project_tree_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| database_error("選択中プロジェクトを確認できません", error))?;
    let deleted = transaction
        .execute("DELETE FROM projects WHERE id = ?1", params![project_id])
        .map_err(|error| database_error("プロジェクトを削除できません", error))?;
    if deleted == 0 {
        return Err("プロジェクトが見つかりません".to_string());
    }
    if active == Some(project_id) {
        let fallback: Option<i64> = transaction
            .query_row(
                "SELECT id FROM projects ORDER BY id ASC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| database_error("代替プロジェクトを取得できません", error))?;
        transaction
            .execute(
                "UPDATE project_tree_state SET active_project_id = ?1 WHERE singleton = 1",
                params![fallback],
            )
            .map_err(|error| database_error("選択中プロジェクトを更新できません", error))?;
    }
    transaction
        .commit()
        .map_err(|error| database_error("プロジェクト削除を確定できません", error))
}

/// サイドバーで選択したプロジェクトを保存する。
pub(super) fn select_project(state: &ProjectTreeState, project_id: i64) -> Result<(), String> {
    let guard = lock_connection(state)?;
    let connection = guard
        .as_ref()
        .expect("lock_connection checked initialization");
    let changed = connection
        .execute(
            "UPDATE project_tree_state SET active_project_id = ?1
             WHERE singleton = 1 AND EXISTS (SELECT 1 FROM projects WHERE id = ?1)",
            params![project_id],
        )
        .map_err(|error| database_error("プロジェクトを選択できません", error))?;
    if changed == 0 {
        return Err("プロジェクトが見つかりません".to_string());
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
    use rusqlite::{params, Connection, TransactionBehavior};

    use super::{
        insert_ordered_node, move_node_in_transaction, ordered_siblings,
        remove_project_nodes_in_transaction, validate_no_cycle,
    };
    use crate::project_order::ORDER_GAP;

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

    #[test]
    fn tied_sort_orders_use_node_id_as_a_stable_secondary_key() {
        let mut connection = memory_database();
        let project_id = create_project(&connection);
        let transaction = connection.transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO project_nodes(project_id, parent_id, kind, name, path, sort_order)
                 VALUES (?1, NULL, 'file', 'first.txt', 'C:/first.txt', 10),
                        (?1, NULL, 'file', 'second.txt', 'C:/second.txt', 10)",
                params![project_id],
            )
            .unwrap();
        let ordered = ordered_siblings(&transaction, project_id, None, None).unwrap();
        assert!(ordered[0].0 < ordered[1].0);
        transaction.rollback().unwrap();
    }

    #[test]
    fn common_moves_with_100_and_3000_siblings_update_one_node_order() {
        for count in [100_i64, 3_000_i64] {
            let mut connection = memory_database();
            let project_id = create_project(&connection);
            let transaction = connection.transaction().unwrap();
            for index in 0..count {
                transaction
                    .execute(
                        "INSERT INTO project_nodes(project_id, parent_id, kind, name, path, sort_order)
                         VALUES (?1, NULL, 'file', 'same.txt', 'C:/same.txt', ?2)",
                        params![project_id, index * ORDER_GAP as i64],
                    )
                    .unwrap();
            }
            transaction.commit().unwrap();

            let (first_id, moved_id): (i64, i64) = connection
                .query_row(
                    "SELECT
                       (SELECT id FROM project_nodes ORDER BY sort_order, id LIMIT 1),
                       (SELECT id FROM project_nodes ORDER BY sort_order DESC, id DESC LIMIT 1)",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            let reindexed =
                move_node_in_transaction(&transaction, moved_id, Some(first_id), "before").unwrap();
            transaction.commit().unwrap();

            let (moved_order, first_order, second_order): (i64, i64, i64) = connection
                .query_row(
                    "SELECT
                       (SELECT sort_order FROM project_nodes WHERE id = ?1),
                       (SELECT sort_order FROM project_nodes WHERE id = ?2),
                       (SELECT sort_order FROM project_nodes ORDER BY sort_order, id LIMIT 1 OFFSET 2)",
                    params![moved_id, first_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert!(!reindexed, "{count}件の通常移動では再採番しない");
            assert_eq!(moved_order, -(ORDER_GAP as i64));
            assert_eq!(first_order, 0);
            assert_eq!(second_order, ORDER_GAP as i64);
        }
    }

    #[test]
    fn exhausted_destination_gap_reindexes_only_destination_siblings() {
        let mut connection = memory_database();
        let project_id = create_project(&connection);
        let transaction = connection.transaction().unwrap();
        let source_folder =
            insert_ordered_node(&transaction, project_id, None, "folder", "source", None).unwrap();
        let destination_folder = insert_ordered_node(
            &transaction,
            project_id,
            None,
            "folder",
            "destination",
            None,
        )
        .unwrap();
        let moving = insert_ordered_node(
            &transaction,
            project_id,
            Some(source_folder),
            "file",
            "moving.txt",
            Some("C:/moving.txt"),
        )
        .unwrap();
        let source_sibling = insert_ordered_node(
            &transaction,
            project_id,
            Some(source_folder),
            "file",
            "remaining.txt",
            Some("C:/remaining.txt"),
        )
        .unwrap();
        let first = insert_ordered_node(
            &transaction,
            project_id,
            Some(destination_folder),
            "file",
            "first.txt",
            Some("C:/first.txt"),
        )
        .unwrap();
        let second = insert_ordered_node(
            &transaction,
            project_id,
            Some(destination_folder),
            "file",
            "second.txt",
            Some("C:/second.txt"),
        )
        .unwrap();
        transaction
            .execute(
                "UPDATE project_nodes SET sort_order = CASE id WHEN ?1 THEN 0 WHEN ?2 THEN 1 END
                 WHERE id IN (?1, ?2)",
                params![first, second],
            )
            .unwrap();
        transaction.commit().unwrap();

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let reindexed =
            move_node_in_transaction(&transaction, moving, Some(first), "after").unwrap();
        transaction.commit().unwrap();

        let destination_orders = connection
            .prepare(
                "SELECT sort_order FROM project_nodes WHERE parent_id = ?1
                 ORDER BY sort_order, id",
            )
            .unwrap()
            .query_map(params![destination_folder], |row| row.get::<_, i64>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let source_sibling_order: i64 = connection
            .query_row(
                "SELECT sort_order FROM project_nodes WHERE id = ?1",
                params![source_sibling],
                |row| row.get(0),
            )
            .unwrap();
        assert!(reindexed);
        assert_eq!(destination_orders.len(), 3);
        assert_eq!(
            destination_orders[1] as i128 - destination_orders[0] as i128,
            ORDER_GAP
        );
        assert_eq!(
            destination_orders[2] as i128 - destination_orders[1] as i128,
            ORDER_GAP
        );
        assert_eq!(source_sibling_order, ORDER_GAP as i64);
    }

    #[test]
    fn moving_folder_into_its_descendant_is_rejected() {
        let mut connection = memory_database();
        let project_id = create_project(&connection);
        let transaction = connection.transaction().unwrap();
        let parent =
            insert_ordered_node(&transaction, project_id, None, "folder", "parent", None).unwrap();
        let child = insert_ordered_node(
            &transaction,
            project_id,
            Some(parent),
            "folder",
            "child",
            None,
        )
        .unwrap();
        assert!(validate_no_cycle(&transaction, project_id, parent, Some(child)).is_err());
        assert!(move_node_in_transaction(&transaction, parent, Some(child), "inside").is_err());
        transaction.rollback().unwrap();
    }

    #[test]
    fn moving_node_to_another_project_is_rejected() {
        let mut connection = memory_database();
        let first_project = create_project(&connection);
        let second_project = create_project(&connection);
        let transaction = connection.transaction().unwrap();
        let moving = insert_ordered_node(
            &transaction,
            first_project,
            None,
            "file",
            "a.txt",
            Some("C:/a.txt"),
        )
        .unwrap();
        let target = insert_ordered_node(
            &transaction,
            second_project,
            None,
            "file",
            "b.txt",
            Some("C:/b.txt"),
        )
        .unwrap();
        assert!(move_node_in_transaction(&transaction, moving, Some(target), "before").is_err());
        transaction.rollback().unwrap();
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
