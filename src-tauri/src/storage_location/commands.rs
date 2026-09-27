//! 保存先関連のTauri commandと実行時ファイル許可を管理する。

use std::path::{Path, PathBuf};

use tauri::{State, Window};
use tauri_plugin_fs::FsExt;

use crate::project_tree::ProjectTreeState;

use super::{
    paths::{PREFERENCES_FILE, PROJECT_TREE_FILE, RECOVERY_FILE},
    state::StorageLocationState,
    StorageStatus,
};

/// 現在の保存先を取得する。起動がブロックされている間も呼び出せる。
#[tauri::command]
pub fn storage_status(state: State<'_, StorageLocationState>) -> Result<StorageStatus, String> {
    state.status()
}

/// 保存先変更を次回起動時に適用するよう予約する。
#[tauri::command]
pub fn storage_schedule_change(
    state: State<'_, StorageLocationState>,
    parent_directory: String,
) -> Result<StorageStatus, String> {
    state.schedule_change(&parent_directory)
}

/// 既定 AppData への移行を次回起動時に予約する。
#[tauri::command]
pub fn storage_schedule_default(
    state: State<'_, StorageLocationState>,
) -> Result<StorageStatus, String> {
    state.schedule_default()
}

/// 既存の保存先へ次回起動時に切り替えるよう予約する。
#[tauri::command]
pub fn storage_schedule_relink_existing(
    state: State<'_, StorageLocationState>,
    data_directory: String,
) -> Result<StorageStatus, String> {
    state.schedule_relink_existing(&data_directory)
}

/// 起動時の保存先解決と DB 初期化を再試行する。
#[tauri::command]
pub fn storage_retry_startup(
    state: State<'_, StorageLocationState>,
    project_tree: State<'_, ProjectTreeState>,
    window: Window,
) -> Result<StorageStatus, String> {
    initialize_active_storage(&state, &project_tree, &window)
}

/// 保留中の保存先変更を取り消す。
#[tauri::command]
pub fn storage_cancel_change(
    state: State<'_, StorageLocationState>,
) -> Result<StorageStatus, String> {
    state.cancel_change()
}

/// 既存のデータフォルダを再指定して、保存先ポインタと DB を復旧する。
#[tauri::command]
pub fn storage_relink_existing(
    state: State<'_, StorageLocationState>,
    project_tree: State<'_, ProjectTreeState>,
    window: Window,
    data_directory: String,
) -> Result<StorageStatus, String> {
    let directory = state.relink_existing(&data_directory)?;
    initialize_database_connection(&state, &project_tree, &window, directory)
}

/// 起動時に設定・復元 Store も読み込めた後、旧データファイルを片付ける。
#[tauri::command]
pub fn storage_confirm_startup(
    state: State<'_, StorageLocationState>,
) -> Result<StorageStatus, String> {
    state.confirm_startup()
}

/// 旧データファイルを残し、後片付けの予約だけを解除する。
#[tauri::command]
pub fn storage_abandon_cleanup(
    state: State<'_, StorageLocationState>,
) -> Result<StorageStatus, String> {
    state.abandon_cleanup()
}

/// DB と Vue Store のために、保存先の個別ファイルだけを実行時許可へ追加する。
pub fn allow_storage_files<R: tauri::Runtime, M: tauri::Manager<R>>(
    window: &M,
    data_directory: &Path,
) -> Result<(), String> {
    for file_name in [PREFERENCES_FILE, RECOVERY_FILE] {
        let file_path = data_directory.join(file_name);
        window.fs_scope().allow_file(&file_path).map_err(|error| {
            format!(
                "保存ファイルを許可できません ({}): {error}",
                file_path.display()
            )
        })?;
    }
    Ok(())
}

/// 予約移行または復旧後の DB を開き、フロントエンド用ファイル許可を設定する。
pub fn initialize_active_storage(
    storage: &StorageLocationState,
    project_tree: &ProjectTreeState,
    window: &Window,
) -> Result<StorageStatus, String> {
    let directory = storage.bootstrap()?;
    initialize_database_connection(storage, project_tree, window, directory)
}

/// 指定保存先へ DB 接続を再設定し、成功したら保存関連 Store のファイルを許可する。
fn initialize_database_connection(
    storage: &StorageLocationState,
    project_tree: &ProjectTreeState,
    window: &Window,
    directory: PathBuf,
) -> Result<StorageStatus, String> {
    let database_path = directory.join(PROJECT_TREE_FILE);
    if let Err(error) = project_tree.reinitialize(Ok(database_path)) {
        let _ = storage.set_blocked_reason(Some(error.clone()));
        return Err(error);
    }
    if let Err(error) = allow_storage_files(window, &directory) {
        let _ = storage.set_blocked_reason(Some(error.clone()));
        return Err(error);
    }
    storage.set_blocked_reason(None)?;
    storage.status()
}
