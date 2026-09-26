//! プロジェクトツリーの並び順、移動、循環検証を担当する。

use rusqlite::{params, OptionalExtension, Transaction};

use crate::project_order::{order_between, reindexed_order_at, PositionError};

use super::database::database_error;

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

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection, TransactionBehavior};

    use super::{
        insert_ordered_node, move_node_in_transaction, ordered_siblings, validate_no_cycle,
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
}
