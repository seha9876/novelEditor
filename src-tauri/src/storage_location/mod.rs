//! アプリ設定、プロジェクト DB、復元データの保存先を管理する。

mod commands;
mod migration;
mod paths;
mod pointer;
mod process_lock;
mod sqlite;
mod state;
mod validation;

use serde::Serialize;

/// 画面が保存先設定と復旧状態を表示するための情報。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    active_directory: String,
    default_directory: String,
    pending_directory: Option<String>,
    blocked_reason: Option<String>,
    cleanup_pending: bool,
}

#[allow(unused_imports)]
pub use commands::{
    allow_storage_files, initialize_active_storage, storage_abandon_cleanup, storage_cancel_change,
    storage_confirm_startup, storage_relink_existing, storage_retry_startup,
    storage_schedule_change, storage_schedule_default, storage_schedule_relink_existing,
    storage_status,
};
pub use state::StorageLocationState;

// Tauriの生成ハンドラが参照する補助項目も、既存のmodule pathで再公開する。
#[doc(hidden)]
pub use commands::{
    __cmd__storage_abandon_cleanup, __cmd__storage_cancel_change, __cmd__storage_confirm_startup,
    __cmd__storage_relink_existing, __cmd__storage_retry_startup, __cmd__storage_schedule_change,
    __cmd__storage_schedule_default, __cmd__storage_schedule_relink_existing,
    __cmd__storage_status, __tauri_command_name_storage_abandon_cleanup,
    __tauri_command_name_storage_cancel_change, __tauri_command_name_storage_confirm_startup,
    __tauri_command_name_storage_relink_existing, __tauri_command_name_storage_retry_startup,
    __tauri_command_name_storage_schedule_change, __tauri_command_name_storage_schedule_default,
    __tauri_command_name_storage_schedule_relink_existing, __tauri_command_name_storage_status,
};

#[cfg(test)]
pub(super) mod test_support {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::process_lock::process_lock_path;

    static TEST_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    pub(super) struct TestDirectory(PathBuf);

    impl TestDirectory {
        /// 他のテストと衝突しない一時保存先を作成する。
        pub(super) fn new() -> Self {
            let sequence = TEST_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "novel-editor-storage-test-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        /// テスト用保存先のパスを返す。
        pub(super) fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
            let _ = fs::remove_file(process_lock_path(&self.0.join("default")));
        }
    }

    /// 保存先の再指定テスト用に空のアプリ DB を作成する。
    pub(super) fn create_project_tree_database(path: &Path) {
        crate::project_tree::prepare_new_database_file(path).unwrap();
    }
}
