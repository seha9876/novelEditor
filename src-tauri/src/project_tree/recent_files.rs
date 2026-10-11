//! 最近利用したTXTの履歴を管理する。本文は保存せず、履歴IDから許可するファイルを限定する。
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{State, Window};
use tauri_plugin_fs::FsExt;

use super::{
    database::{database_error, lock_connection},
    ProjectTreeState,
};

#[derive(Debug, Serialize, PartialEq)]
pub struct RecentFile {
    id: i64,
    path: String,
    position: Option<EditorPosition>,
}

/// 折り返しに依存しない、1始まりの論理行と書記素列。
#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct EditorPosition {
    line: i64,
    column: i64,
}

/// LEFT JOINで位置がない旧履歴も読み取り、本文やディスクへのアクセスは行わない。
fn read_recent_file(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecentFile> {
    let line: Option<i64> = row.get(2)?;
    Ok(RecentFile {
        id: row.get(0)?,
        path: row.get(1)?,
        position: match line {
            Some(line) => Some(EditorPosition {
                line,
                column: row.get(3)?,
            }),
            None => None,
        },
    })
}

/// 履歴を管理するメイン窓からの呼び出しだけを許可する。
fn require_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("ファイル履歴はメイン画面から操作してください".into())
    }
}

/// 許可範囲と絶対パスを先に検査し、許可されていないパスのファイル情報を調べない。
fn validate_record_access(path: &Path, allowed: bool) -> Result<(), String> {
    if !path.is_absolute() || !allowed {
        return Err("このファイルは許可範囲にありません。ファイル選択から開いてください".into());
    }
    Ok(())
}

/// 実在する通常のTXTだけを解決する。リンク先もTXTに限定し、保存後の再検証と一致させる。
fn resolve_text_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("txt"))
    {
        return Err("絶対パスのTXTファイルを指定してください".into());
    }
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("参照先ファイルを確認できません: {error}"))?;
    if !metadata.is_file() {
        return Err("参照先が通常ファイルではありません".into());
    }
    let resolved = std::fs::canonicalize(path)
        .map_err(|error| format!("ファイルのパスを解決できません: {error}"))?;
    if !resolved
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("txt"))
    {
        return Err("参照先がTXTファイルではありません".into());
    }
    Ok(resolved)
}

/// Windowsでは英字の大小を区別せず、正規化済みパスを履歴の比較キーにする。
fn path_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

/// 保存された順序で最新20件を返す。表示のために参照先ファイルへはアクセスしない。
fn list(connection: &Connection) -> Result<Vec<RecentFile>, String> {
    let mut statement = connection
        .prepare(
            "SELECT f.id, f.path, p.line, p.column FROM recent_files f
                  LEFT JOIN recent_file_positions p ON p.recent_file_id = f.id
                  ORDER BY f.last_used DESC, f.id DESC LIMIT 20",
        )
        .map_err(|error| database_error("ファイル履歴を取得できません", error))?;
    let rows = statement
        .query_map([], read_recent_file)
        .map_err(|error| database_error("ファイル履歴を読み取れません", error))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("ファイル履歴を読み取れません", error))
}

/// 記録と件数制限を一つのトランザクションにし、同じファイルのIDを保って先頭へ移す。
fn record(connection: &mut Connection, path: &str) -> Result<RecentFile, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| database_error("履歴の更新を開始できません", error))?;
    transaction
        .execute(
            "INSERT INTO recent_files(path, path_key, last_used)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(last_used), 0) + 1 FROM recent_files))
         ON CONFLICT(path_key) DO UPDATE SET path = excluded.path, last_used = excluded.last_used",
            params![path, path_key(path)],
        )
        .map_err(|error| database_error("ファイル履歴を記録できません", error))?;
    transaction.execute("DELETE FROM recent_files WHERE id NOT IN (SELECT id FROM recent_files ORDER BY last_used DESC, id DESC LIMIT 20)", [])
        .map_err(|error| database_error("古い履歴を整理できません", error))?;
    let entry = transaction
        .query_row(
            "SELECT f.id, f.path, p.line, p.column FROM recent_files f
         LEFT JOIN recent_file_positions p ON p.recent_file_id = f.id WHERE f.path_key = ?1",
            [path_key(path)],
            read_recent_file,
        )
        .map_err(|error| database_error("編集位置を読み取れません", error))?;
    transaction
        .commit()
        .map_err(|error| database_error("ファイル履歴を保存できません", error))?;
    Ok(entry)
}

/// 既存履歴だけの位置を更新する。削除済みIDは無視し、履歴順や実ファイルは変更しない。
fn update_position(
    connection: &Connection,
    id: i64,
    position: EditorPosition,
) -> Result<(), String> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if id < 1
        || !(1..=MAX_SAFE_INTEGER).contains(&position.line)
        || !(1..=MAX_SAFE_INTEGER).contains(&position.column)
    {
        return Err("編集位置には1以上の安全な整数を指定してください".into());
    }
    connection
        .execute(
            "INSERT INTO recent_file_positions(recent_file_id, line, column)
         SELECT id, ?2, ?3 FROM recent_files WHERE id = ?1
         ON CONFLICT(recent_file_id) DO UPDATE SET line = excluded.line, column = excluded.column",
            params![id, position.line, position.column],
        )
        .map_err(|error| database_error("編集位置を保存できません", error))?;
    Ok(())
}

/// 指定された履歴だけを削除する。Noneは全消去で、実ファイルは操作しない。
fn remove(connection: &Connection, id: Option<i64>) -> Result<(), String> {
    if let Some(id) = id {
        connection.execute("DELETE FROM recent_files WHERE id = ?1", [id])
    } else {
        connection.execute("DELETE FROM recent_files", [])
    }
    .map_err(|error| database_error("ファイル履歴を削除できません", error))?;
    Ok(())
}

/// クライアントの任意パスではなく、保存済みIDから参照先を取得する。
fn stored_path(connection: &Connection, id: i64) -> Result<String, String> {
    connection
        .query_row("SELECT path FROM recent_files WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| database_error("ファイル履歴を取得できません", error))?
        .ok_or_else(|| "この履歴は既に削除されています".into())
}

/// メイン画面の履歴一覧を読み込む。
#[tauri::command]
pub fn recent_files_list(
    window: Window,
    state: State<'_, ProjectTreeState>,
) -> Result<Vec<RecentFile>, String> {
    require_main(window.label())?;
    let guard = lock_connection(&state)?;
    list(guard.as_ref().expect("checked connection"))
}

/// 読込・保存に成功した許可済みTXTを履歴へ記録する。
#[tauri::command]
pub fn recent_file_record(
    window: Window,
    state: State<'_, ProjectTreeState>,
    path: String,
) -> Result<RecentFile, String> {
    require_main(window.label())?;
    let path = Path::new(&path);
    validate_record_access(path, window.fs_scope().is_allowed(path))?;
    let resolved = resolve_text_path(path)?;
    validate_record_access(&resolved, window.fs_scope().is_allowed(&resolved))?;
    let path = resolved
        .to_str()
        .ok_or("ファイル名を文字列として扱えません")?;
    let mut guard = lock_connection(&state)?;
    record(guard.as_mut().expect("checked connection"), path)
}

/// メイン窓が保持する履歴IDへ位置だけを記録する。ファイルの再許可は行わない。
#[tauri::command]
pub fn recent_file_position_update(
    window: Window,
    state: State<'_, ProjectTreeState>,
    id: i64,
    position: EditorPosition,
) -> Result<(), String> {
    require_main(window.label())?;
    let guard = lock_connection(&state)?;
    update_position(guard.as_ref().expect("checked connection"), id, position)
}

/// 指定した履歴項目だけを削除する。
#[tauri::command]
pub fn recent_files_remove(
    window: Window,
    state: State<'_, ProjectTreeState>,
    id: i64,
) -> Result<(), String> {
    require_main(window.label())?;
    let guard = lock_connection(&state)?;
    remove(guard.as_ref().expect("checked connection"), Some(id))
}

/// 利用者が確認した履歴の全消去を行う。
#[tauri::command]
pub fn recent_files_clear(
    window: Window,
    state: State<'_, ProjectTreeState>,
) -> Result<(), String> {
    require_main(window.label())?;
    let guard = lock_connection(&state)?;
    remove(guard.as_ref().expect("checked connection"), None)
}

/// 履歴IDのTXTを再検証し、そのファイルだけを今回の実行の読み書き許可へ追加する。
#[tauri::command]
pub fn recent_file_authorize(
    window: Window,
    state: State<'_, ProjectTreeState>,
    id: i64,
) -> Result<String, String> {
    require_main(window.label())?;
    let guard = lock_connection(&state)?;
    let path = stored_path(guard.as_ref().expect("checked connection"), id)?;
    let resolved = resolve_text_path(Path::new(&path))?;
    window
        .fs_scope()
        .allow_file(&resolved)
        .map_err(|error| format!("ファイルの読み書きを許可できません: {error}"))?;
    resolved
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "ファイル名を文字列として扱えません".into())
}

#[cfg(test)]
mod tests {
    use super::super::database::create_schema;
    use super::*;

    /// 本番と同じスキーマで履歴だけを検証するメモリDBを用意する。
    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        create_schema(&connection).unwrap();
        connection
    }

    /// 位置更新は履歴順に触れず、再記録・件数整理・削除でもIDとの対応を維持する。
    #[test]
    fn positions_follow_history_without_changing_order() {
        let mut connection = database();
        let first = record(&mut connection, "C:/最初.txt").unwrap();
        let second = record(&mut connection, "C:/次.txt").unwrap();
        update_position(
            &connection,
            first.id,
            EditorPosition {
                line: 12,
                column: 3,
            },
        )
        .unwrap();
        let entries = list(&connection).unwrap();
        assert_eq!(entries[0].id, second.id);
        assert_eq!(
            entries[1].position,
            Some(EditorPosition {
                line: 12,
                column: 3
            })
        );
        let updated = record(&mut connection, &first.path).unwrap();
        assert_eq!(updated.id, first.id);
        assert_eq!(updated.position, entries[1].position);
        remove(&connection, Some(first.id)).unwrap();
        update_position(&connection, first.id, EditorPosition { line: 1, column: 1 }).unwrap();
        assert_eq!(list(&connection).unwrap().len(), 1);
        update_position(
            &connection,
            second.id,
            EditorPosition { line: 2, column: 2 },
        )
        .unwrap();
        for index in 0..20 {
            record(&mut connection, &format!("C:/追加{index}.txt")).unwrap();
        }
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM recent_file_positions", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
        let newest = list(&connection).unwrap()[0].id;
        update_position(&connection, newest, EditorPosition { line: 3, column: 3 }).unwrap();
        remove(&connection, None).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM recent_file_positions", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
    }

    /// JSで安全に扱える正の整数だけを受け付け、不正要求で保存済みの位置を壊さない。
    #[test]
    fn rejects_invalid_positions() {
        let mut connection = database();
        let entry = record(&mut connection, "C:/原稿.txt").unwrap();
        update_position(&connection, entry.id, EditorPosition { line: 5, column: 8 }).unwrap();
        for (line, column) in [
            (0, 1),
            (1, 0),
            (-1, 1),
            (1, -1),
            (i64::MAX, 1),
            (1, i64::MAX),
        ] {
            assert!(
                update_position(&connection, entry.id, EditorPosition { line, column }).is_err()
            );
        }
        assert!(update_position(&connection, 0, EditorPosition { line: 1, column: 1 }).is_err());
        assert!(serde_json::from_str::<EditorPosition>(r#"{"line":1.5,"column":1}"#).is_err());
        assert_eq!(
            list(&connection).unwrap()[0].position,
            Some(EditorPosition { line: 5, column: 8 })
        );
    }

    /// 重複はIDを保って先頭へ移し、最新20件だけを残す。
    #[test]
    fn promotes_existing_file_and_limits_to_twenty() {
        let mut connection = database();
        for index in 0..20 {
            record(&mut connection, &format!("C:/作品{index}/原稿.txt")).unwrap();
        }
        let before = list(&connection).unwrap();
        let oldest = before.last().unwrap();
        record(&mut connection, &oldest.path).unwrap();
        assert_eq!(list(&connection).unwrap()[0], *oldest);
        record(&mut connection, "D:/新しい原稿.txt").unwrap();
        let after = list(&connection).unwrap();
        assert_eq!(after.len(), 20);
        assert_eq!(after[0].path, "D:/新しい原稿.txt");
        assert_eq!(after[1], *oldest);
        assert!(!after.iter().any(|item| item.path == "C:/作品1/原稿.txt"));
        assert_eq!(stored_path(&connection, oldest.id).unwrap(), oldest.path);
    }

    /// プロジェクト削除は履歴に影響せず、履歴IDの個別削除と全消去が独立する。
    #[test]
    fn project_deletion_does_not_remove_history() {
        let mut connection = database();
        record(&mut connection, "C:/原稿.txt").unwrap();
        record(&mut connection, "D:/原稿.txt").unwrap();
        connection
            .execute("INSERT INTO projects(name) VALUES ('作品')", [])
            .unwrap();
        connection.execute("DELETE FROM projects", []).unwrap();
        let entries = list(&connection).unwrap();
        assert_eq!(entries.len(), 2);
        remove(&connection, Some(entries[0].id)).unwrap();
        assert!(stored_path(&connection, entries[0].id).is_err());
        assert_eq!(
            list(&connection).unwrap(),
            vec![RecentFile {
                id: entries[1].id,
                path: entries[1].path.clone(),
                position: None,
            }]
        );
        remove(&connection, None).unwrap();
        assert!(list(&connection).unwrap().is_empty());
    }

    /// 保存失敗で先頭移動や件数削除を部分適用しない。
    #[test]
    fn failed_record_rolls_back_history() {
        let mut connection = database();
        record(&mut connection, "C:/原稿.txt").unwrap();
        let before = list(&connection).unwrap();
        connection.execute_batch("CREATE TRIGGER fail_recent BEFORE DELETE ON recent_files BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        for index in 0..19 {
            record(&mut connection, &format!("C:/{index}.txt")).unwrap();
        }
        let full = list(&connection).unwrap();
        assert!(record(&mut connection, "C:/失敗.txt").is_err());
        assert_eq!(list(&connection).unwrap(), full);
        assert_eq!(full.last().unwrap(), &before[0]);
    }

    /// メイン窓と許可済み絶対パスに限定し、ファイル確認前に不正要求を拒否する。
    #[test]
    fn requires_main_window_and_allowed_absolute_path() {
        assert!(require_main("main").is_ok());
        for label in ["settings", "project-tree", "search", ""] {
            assert!(require_main(label).is_err());
        }
        assert!(validate_record_access(Path::new("relative.txt"), true).is_err());
        let absolute = std::env::temp_dir().join("recent-file.txt");
        assert!(validate_record_access(&absolute, false).is_err());
        assert!(validate_record_access(&absolute, true).is_ok());
        assert!(resolve_text_path(Path::new("relative.txt")).is_err());
        assert!(resolve_text_path(&absolute.with_extension("exe")).is_err());
        if cfg!(windows) {
            assert_eq!(path_key("C:/TEST.txt"), path_key("c:/test.TXT"));
        }
    }

    /// 再接続しても順序とIDを復元でき、欠落した原稿も履歴の削除まで残る。
    #[test]
    fn persists_across_restart_and_never_deletes_manuscripts() {
        let directory =
            std::env::temp_dir().join(format!("novel-editor-recent-test-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let manuscript = directory.join("原稿.TXT");
        let missing = directory.join("欠落.txt");
        let folder = directory.join("フォルダ.txt");
        std::fs::write(&manuscript, b"manuscript").unwrap();
        std::fs::create_dir(&folder).unwrap();
        assert!(resolve_text_path(&folder).is_err());
        assert!(resolve_text_path(&missing).is_err());
        let canonical = resolve_text_path(&manuscript).unwrap();
        let database_path = directory.join("history.sqlite3");
        let mut connection = Connection::open(&database_path).unwrap();
        create_schema(&connection).unwrap();
        let manuscript_entry = record(&mut connection, canonical.to_str().unwrap()).unwrap();
        update_position(
            &connection,
            manuscript_entry.id,
            EditorPosition {
                line: 99,
                column: 12,
            },
        )
        .unwrap();
        record(&mut connection, missing.to_str().unwrap()).unwrap();
        let before = list(&connection).unwrap();
        drop(connection);
        let connection = Connection::open(&database_path).unwrap();
        create_schema(&connection).unwrap();
        assert_eq!(list(&connection).unwrap(), before);
        assert!(
            resolve_text_path(Path::new(&stored_path(&connection, before[0].id).unwrap())).is_err()
        );
        assert_eq!(list(&connection).unwrap(), before);
        remove(&connection, None).unwrap();
        assert_eq!(std::fs::read(&manuscript).unwrap(), b"manuscript");
        drop(connection);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
