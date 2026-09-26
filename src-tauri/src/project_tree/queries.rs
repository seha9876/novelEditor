//! プロジェクトツリーの照会処理を担当する。

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use super::{
    database::{database_error, lock_connection},
    ProjectInfo, ProjectNodeInfo, ProjectTreeSnapshot, ProjectTreeState,
};

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
