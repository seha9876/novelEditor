mod project_order;
mod project_tree;
mod storage_location;

use project_tree::ProjectTreeState;
use storage_location::{allow_storage_files, StorageLocationState};
use tauri::Manager;

// Tauri 本体と、ファイル操作・設定永続化に必要なプラグインを登録して起動する。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let default_directory = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("アプリデータフォルダを取得できません: {error}"))?;
            let storage_location = StorageLocationState::new(default_directory);
            let database_path = storage_location
                .bootstrap()
                .map(|directory| directory.join("project-tree.sqlite3"));
            let project_tree = ProjectTreeState::initialize(database_path);
            if let Some(error) = project_tree.initialization_error()? {
                storage_location.set_blocked_reason(Some(error))?;
            } else if let Some(window) = app.get_webview_window("main") {
                if let Err(error) =
                    allow_storage_files(&window, &storage_location.active_directory_path()?)
                {
                    storage_location.set_blocked_reason(Some(error))?;
                }
            }
            app.manage(project_tree);
            app.manage(storage_location);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            project_tree::project_tree_snapshot,
            project_tree::project_create,
            project_tree::project_rename,
            project_tree::project_delete,
            project_tree::project_select,
            project_tree::project_folder_create,
            project_tree::project_folder_rename,
            project_tree::project_file_register,
            project_tree::project_file_relink,
            project_tree::project_node_remove,
            project_tree::project_node_move,
            project_tree::project_file_authorize,
            storage_location::storage_status,
            storage_location::storage_schedule_change,
            storage_location::storage_schedule_default,
            storage_location::storage_schedule_relink_existing,
            storage_location::storage_cancel_change,
            storage_location::storage_retry_startup,
            storage_location::storage_relink_existing,
            storage_location::storage_confirm_startup,
            storage_location::storage_abandon_cleanup,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the novel editor");
}
