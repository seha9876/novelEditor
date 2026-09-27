//! プロジェクトの作成、選択、名前変更、削除を担当する。

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use super::{
    database::{database_error, lock_connection},
    ProjectTreeState,
};

/// 空白だけの名前を拒否し、保存時の前後空白を取り除く。
pub(super) fn normalized_name(name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("名前を入力してください".to_string());
    }
    Ok(name)
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
