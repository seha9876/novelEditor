//! 検索条件の履歴を管理する。本文・検索範囲・ファイルへの参照は保存しない。
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{State, Window};

use super::{
    database::{database_error, lock_connection},
    ProjectTreeState,
};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchConditions {
    search: String,
    replace: String,
    case_sensitive: bool,
    regexp: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SearchHistoryEntry {
    id: i64,
    conditions: SearchConditions,
}

/// 履歴の読み書きを、検索セッションを管理するメイン窓に限定する。
fn require_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("検索履歴はメイン画面から操作してください".into())
    }
}

/// 検索条件を加工せず、使用順に最大20件読み出す。
fn list(connection: &Connection) -> Result<Vec<SearchHistoryEntry>, String> {
    let mut statement = connection.prepare(
        "SELECT id, search, replacement, case_sensitive, regexp FROM search_history ORDER BY last_used DESC, id DESC LIMIT 20"
    ).map_err(|error| database_error("検索履歴を取得できません", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SearchHistoryEntry {
                id: row.get(0)?,
                conditions: SearchConditions {
                    search: row.get(1)?,
                    replace: row.get(2)?,
                    case_sensitive: row.get(3)?,
                    regexp: row.get(4)?,
                },
            })
        })
        .map_err(|error| database_error("検索履歴を読み取れません", error))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("検索履歴を読み取れません", error))
}

/// 完全一致する条件のIDを保って最新へ移し、件数制限まで一括で保存する。
fn record(
    connection: &mut Connection,
    conditions: SearchConditions,
) -> Result<Vec<SearchHistoryEntry>, String> {
    if conditions.search.is_empty() {
        return Err("空の検索語は履歴へ保存できません".into());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| database_error("検索履歴の更新を開始できません", error))?;
    transaction.execute(
        "INSERT INTO search_history(search, replacement, case_sensitive, regexp, last_used)
         VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(last_used), 0) + 1 FROM search_history))
         ON CONFLICT(search, replacement, case_sensitive, regexp) DO UPDATE SET last_used = excluded.last_used",
        params![conditions.search, conditions.replace, conditions.case_sensitive, conditions.regexp],
    ).map_err(|error| database_error("検索履歴を記録できません", error))?;
    transaction.execute("DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY last_used DESC, id DESC LIMIT 20)", [])
        .map_err(|error| database_error("古い検索履歴を整理できません", error))?;
    transaction
        .commit()
        .map_err(|error| database_error("検索履歴を保存できません", error))?;
    list(connection)
}

/// 指定項目または全件を削除し、更新後の一覧を返す。存在しないIDは何もしない。
fn remove(connection: &Connection, id: Option<i64>) -> Result<Vec<SearchHistoryEntry>, String> {
    connection
        .execute(
            "DELETE FROM search_history WHERE ?1 IS NULL OR id = ?1",
            [id],
        )
        .map_err(|error| database_error("検索履歴を削除できません", error))?;
    list(connection)
}

/// 起動時の共有履歴を取得する。
#[tauri::command]
pub fn search_history_list(
    window: Window,
    state: State<'_, ProjectTreeState>,
) -> Result<Vec<SearchHistoryEntry>, String> {
    require_main(window.label())?;
    let guard = lock_connection(&state)?;
    list(guard.as_ref().expect("checked connection"))
}

/// メイン側で受理した明示操作の検索条件を保存する。
#[tauri::command]
pub fn search_history_record(
    window: Window,
    state: State<'_, ProjectTreeState>,
    conditions: SearchConditions,
) -> Result<Vec<SearchHistoryEntry>, String> {
    require_main(window.label())?;
    let mut guard = lock_connection(&state)?;
    record(guard.as_mut().expect("checked connection"), conditions)
}

/// 利用者が指定した履歴だけを削除する。
#[tauri::command]
pub fn search_history_remove(
    window: Window,
    state: State<'_, ProjectTreeState>,
    id: i64,
) -> Result<Vec<SearchHistoryEntry>, String> {
    require_main(window.label())?;
    let guard = lock_connection(&state)?;
    remove(guard.as_ref().expect("checked connection"), Some(id))
}

/// 利用者が確認した履歴の全件削除を行う。
#[tauri::command]
pub fn search_history_clear(
    window: Window,
    state: State<'_, ProjectTreeState>,
) -> Result<Vec<SearchHistoryEntry>, String> {
    require_main(window.label())?;
    let guard = lock_connection(&state)?;
    remove(guard.as_ref().expect("checked connection"), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト用の条件を作る。空の置換文字も削除条件として保持する。
    fn conditions(search: &str) -> SearchConditions {
        SearchConditions {
            search: search.into(),
            replace: String::new(),
            case_sensitive: false,
            regexp: false,
        }
    }

    /// 上限、完全一致の重複、オプション違い、空白・改行を実際のDBで検証する。
    #[test]
    fn keeps_twenty_exact_conditions_in_usage_order() {
        let mut db = Connection::open_in_memory().unwrap();
        super::super::database::create_schema(&db).unwrap();
        for n in 0..21 {
            record(&mut db, conditions(&n.to_string())).unwrap();
        }
        let entries = list(&db).unwrap();
        assert_eq!(entries.len(), 20);
        assert_eq!(entries[0].conditions.search, "20");
        assert_eq!(entries[19].conditions.search, "1");
        let reused = record(&mut db, conditions("1")).unwrap();
        assert_eq!(reused[0].id, entries[19].id);
        let mut flags = conditions("1");
        flags.case_sensitive = true;
        record(&mut db, flags.clone()).unwrap();
        flags.regexp = true;
        record(&mut db, flags).unwrap();
        assert_eq!(
            list(&db)
                .unwrap()
                .iter()
                .filter(|e| e.conditions.search == "1")
                .count(),
            3
        );
        let multiline = SearchConditions {
            search: "(星)\n月".into(),
            replace: "$1\n日".into(),
            case_sensitive: false,
            regexp: true,
        };
        assert_eq!(
            record(&mut db, multiline.clone()).unwrap()[0].conditions,
            multiline
        );
        assert_eq!(
            record(&mut db, conditions(" ")).unwrap()[0]
                .conditions
                .search,
            " "
        );
        assert!(record(&mut db, conditions("")).is_err());
        let id = list(&db).unwrap()[0].id;
        assert_eq!(remove(&db, Some(id)).unwrap().len(), 19);
        assert_eq!(remove(&db, Some(id)).unwrap().len(), 19);
        assert!(remove(&db, None).unwrap().is_empty());
        assert!(require_main("main").is_ok());
        for label in ["search", "settings", "project-tree"] {
            assert!(require_main(label).is_err());
        }
    }
}
