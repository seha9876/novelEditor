//! アプリ設定、プロジェクト DB、復元データの保存先を管理する。

mod migration;
mod pointer;
mod validation;

use std::{
    collections::BTreeMap,
    fs::{self, File},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use serde::Serialize;
use tauri::{State, Window};
use tauri_plugin_fs::FsExt;

use crate::project_tree::ProjectTreeState;

use migration::{
    ensure_project_tree_database, fingerprint_data_files, fingerprint_file, migrate_data_files,
};
use pointer::{
    acquire_process_lock, display_path, pointer_version, process_lock_path, read_pointer,
    same_existing_path, write_pointer_atomic, StoragePointer,
};
use validation::{
    canonical_directory, validate_existing_data_directory, verify_writable_directory,
};

const POINTER_FILE: &str = "storage-location.json";
const APP_DATA_DIRECTORY: &str = "novelEditor-data";
const PREFERENCES_FILE: &str = "preferences.json";
const PROJECT_TREE_FILE: &str = "project-tree.sqlite3";
const RECOVERY_FILE: &str = "recovery.json";
const DATA_FILES: [&str; 3] = [PREFERENCES_FILE, PROJECT_TREE_FILE, RECOVERY_FILE];

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

/// 起動時に読み込んだ保存先設定と、現在の起動可否を保持する。
pub struct StorageLocationState {
    default_directory: PathBuf,
    pointer_file: PathBuf,
    runtime: Mutex<RuntimeStorageState>,
    process_lock: Mutex<Option<File>>,
}

struct RuntimeStorageState {
    pointer: StoragePointer,
    pointer_error: Option<String>,
    blocked_reason: Option<String>,
}

impl StorageLocationState {
    /// AppData のポインタを読み込み、まだデータファイルの操作は行わない。
    pub fn new(default_directory: PathBuf) -> Self {
        let lock_path = process_lock_path(&default_directory);
        let (process_lock, process_lock_error) = match acquire_process_lock(&lock_path) {
            Ok(file) => (Some(file), None),
            Err(error) => (None, Some(error)),
        };
        let pointer_file = default_directory.join(POINTER_FILE);
        let (pointer, pointer_error) = match read_pointer(&pointer_file) {
            Ok(pointer) => (pointer, None),
            Err(error) => (StoragePointer::default(), Some(error)),
        };
        let blocked_reason = process_lock_error.or_else(|| pointer_error.clone());
        Self {
            default_directory,
            pointer_file,
            runtime: Mutex::new(RuntimeStorageState {
                pointer,
                pointer_error,
                blocked_reason,
            }),
            process_lock: Mutex::new(process_lock),
        }
    }

    /// 保存先を解決し、保留中のコピー移行を SQLite 初期化より先に完了する。
    pub fn bootstrap(&self) -> Result<PathBuf, String> {
        if let Err(error) = self.ensure_process_lock() {
            self.set_blocked_reason(Some(error.clone()))?;
            return Err(error);
        }
        let mut runtime = self.lock_runtime()?;
        match read_pointer(&self.pointer_file) {
            Ok(pointer) => {
                runtime.pointer = pointer;
                runtime.pointer_error = None;
            }
            Err(error) => {
                runtime.pointer_error = Some(error.clone());
                runtime.blocked_reason = Some(error.clone());
                return Err(error);
            }
        }
        let result = self.bootstrap_locked(&mut runtime);
        runtime.blocked_reason = result.as_ref().err().cloned();
        result
    }

    /// 保留中の移行を適用し、現在利用するディレクトリを返す。
    fn bootstrap_locked(&self, runtime: &mut RuntimeStorageState) -> Result<PathBuf, String> {
        if let Some(error) = &runtime.pointer_error {
            return Err(error.clone());
        }

        if let Some(target_directory) = runtime.pointer.pending_directory.clone() {
            let mut next_pointer = runtime.pointer.clone();
            let source_directory = self.active_directory(&runtime.pointer);
            let (cleanup_directory, cleanup_fingerprints) = if runtime
                .pointer
                .pending_relink_existing
            {
                validate_existing_data_directory(&target_directory)?;
                // 再リンクは既存データを選び直すだけなので、旧保存先には触れない。
                (None, BTreeMap::new())
            } else {
                if same_existing_path(&source_directory, &target_directory) {
                    return Err(
                        "移行元と移行先が同じです。設定画面から保存先を選び直してください"
                            .to_string(),
                    );
                }
                if !same_existing_path(&source_directory, &self.default_directory) {
                    validate_existing_data_directory(&source_directory).map_err(|error| {
                        format!(
                            "現在の保存先を移行元として利用できません。既存データフォルダを再指定してください: {error}"
                        )
                    })?;
                }
                let source_fingerprints = fingerprint_data_files(&source_directory)?;
                let source_has_database = source_fingerprints.contains_key(PROJECT_TREE_FILE);
                if source_has_database {
                    crate::project_tree::validate_database_file(
                        &source_directory.join(PROJECT_TREE_FILE),
                    )?;
                }
                migrate_data_files(&source_directory, &target_directory)?;
                let fingerprints_after_copy = fingerprint_data_files(&source_directory)?;
                if source_fingerprints != fingerprints_after_copy {
                    return Err("移行中に元データが変更されたため、保存先を切り替えませんでした。アプリを1つだけ起動して再試行してください".to_string());
                }
                if !source_has_database {
                    // 元 DB がない初回移行では、ポインタ確定前に新規 DB を用意する。
                    ensure_project_tree_database(&target_directory.join(PROJECT_TREE_FILE))?;
                }
                if source_directory != target_directory && !source_fingerprints.is_empty() {
                    (Some(source_directory), source_fingerprints)
                } else {
                    (None, BTreeMap::new())
                }
            };
            next_pointer.active_directory =
                if same_existing_path(&target_directory, &self.default_directory) {
                    None
                } else {
                    Some(target_directory.clone())
                };
            next_pointer.pending_directory = None;
            next_pointer.pending_relink_existing = false;
            next_pointer.cleanup_directory = cleanup_directory;
            next_pointer.cleanup_fingerprints = cleanup_fingerprints;
            write_pointer_atomic(&self.pointer_file, &next_pointer)?;
            runtime.pointer = next_pointer;
        }

        let active_directory = self.active_directory(&runtime.pointer);
        if same_existing_path(&active_directory, &self.default_directory) {
            fs::create_dir_all(&self.default_directory)
                .map_err(|error| format!("既定の保存先を作成できません: {error}"))?;
            ensure_project_tree_database(&active_directory.join(PROJECT_TREE_FILE))?;
        } else {
            validate_existing_data_directory(&active_directory).map_err(|error| {
                format!(
                    "選択中の保存先を利用できません。再試行するか、既存データフォルダを指定してください: {error}"
                )
            })?;
        }

        Ok(active_directory)
    }

    /// 保存先変更や復旧画面で表示する現在の状態を返す。
    pub fn status(&self) -> Result<StorageStatus, String> {
        let runtime = self.lock_runtime()?;
        Ok(self.status_locked(&runtime))
    }

    /// 起動時の設定ファイル許可に使う現在の保存先を返す。
    pub fn active_directory_path(&self) -> Result<PathBuf, String> {
        let runtime = self.lock_runtime()?;
        Ok(self.active_directory(&runtime.pointer))
    }

    /// 移行後に旧保存先の既知データファイルだけを削除する。
    pub fn confirm_startup(&self) -> Result<StorageStatus, String> {
        self.ensure_process_lock()?;
        let mut runtime = self.lock_runtime()?;
        let Some(cleanup_directory) = runtime.pointer.cleanup_directory.clone() else {
            return Ok(self.status_locked(&runtime));
        };
        let active_directory = self.active_directory(&runtime.pointer);
        if same_existing_path(&cleanup_directory, &active_directory) {
            return Err("移行元と現在の保存先が同じため、旧データを削除できません".to_string());
        }

        let mut files_to_remove = Vec::new();
        for file_name in DATA_FILES {
            let file_path = cleanup_directory.join(file_name);
            match fs::symlink_metadata(&file_path) {
                Ok(metadata) if metadata.file_type().is_file() => {
                    let expected = runtime
                        .pointer
                        .cleanup_fingerprints
                        .get(file_name)
                        .ok_or_else(|| {
                            format!("旧保存先の検証情報がありません: {}", file_path.display())
                        })?;
                    if fingerprint_file(&file_path)? != *expected {
                        return Err(format!(
                            "移行後に旧データが変更されたため削除しませんでした。ファイルを確認してから旧データを整理してください: {}",
                            file_path.display()
                        ));
                    }
                    files_to_remove.push(file_path);
                }
                Ok(_) => {
                    return Err(format!(
                        "旧保存先の対象が通常ファイルではないため削除できません: {}",
                        file_path.display()
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "旧保存先を確認できません ({}): {error}",
                        file_path.display()
                    ));
                }
            }
        }
        for file_path in files_to_remove {
            fs::remove_file(&file_path).map_err(|error| {
                format!(
                    "旧保存先のファイルを削除できません ({}): {error}",
                    file_path.display()
                )
            })?;
        }

        let mut next_pointer = runtime.pointer.clone();
        next_pointer.cleanup_directory = None;
        next_pointer.cleanup_fingerprints.clear();
        write_pointer_atomic(&self.pointer_file, &next_pointer)?;
        runtime.pointer = next_pointer;
        Ok(self.status_locked(&runtime))
    }

    /// 旧ファイルを残したまま、後片付けの予約だけを解除する。
    pub fn abandon_cleanup(&self) -> Result<StorageStatus, String> {
        self.ensure_process_lock()?;
        let mut runtime = self.lock_runtime()?;
        if runtime.pointer.cleanup_directory.is_none() {
            return Ok(self.status_locked(&runtime));
        }

        let mut next_pointer = runtime.pointer.clone();
        next_pointer.cleanup_directory = None;
        next_pointer.cleanup_fingerprints.clear();
        write_pointer_atomic(&self.pointer_file, &next_pointer)?;
        runtime.pointer = next_pointer;
        Ok(self.status_locked(&runtime))
    }

    /// 起動失敗を状態に反映し、復旧画面へ理由を返す。
    pub fn set_blocked_reason(&self, reason: Option<String>) -> Result<(), String> {
        self.lock_runtime()?.blocked_reason = reason;
        Ok(())
    }

    /// 設定画面で選んだ親フォルダに、次回起動時の移行先を予約する。
    pub fn schedule_change(&self, parent_directory: &str) -> Result<StorageStatus, String> {
        let parent_directory = canonical_directory(parent_directory)?;
        let target_directory = parent_directory.join(APP_DATA_DIRECTORY);
        self.schedule_directory(target_directory)
    }

    /// 既定の AppData へ次回起動時に戻す。
    pub fn schedule_default(&self) -> Result<StorageStatus, String> {
        self.schedule_directory(self.default_directory.clone())
    }

    /// 既存データフォルダへの切替を次回起動時に予約する。
    pub fn schedule_relink_existing(&self, data_directory: &str) -> Result<StorageStatus, String> {
        self.ensure_process_lock()?;
        let data_directory = canonical_directory(data_directory)?;
        validate_existing_data_directory(&data_directory)?;
        let mut runtime = self.lock_runtime()?;
        if let Some(reason) = &runtime.blocked_reason {
            return Err(format!(
                "保存先が利用できないため変更を予約できません: {reason}"
            ));
        }
        if same_existing_path(&self.active_directory(&runtime.pointer), &data_directory) {
            return Ok(self.status_locked(&runtime));
        }
        if runtime.pointer.cleanup_directory.is_some() {
            return Err("旧保存先の片付けが未完了です。再試行してから変更してください".to_string());
        }
        verify_writable_directory(&data_directory)?;
        let mut next_pointer = runtime.pointer.clone();
        next_pointer.pending_directory = Some(data_directory);
        next_pointer.pending_relink_existing = true;
        write_pointer_atomic(&self.pointer_file, &next_pointer)?;
        runtime.pointer = next_pointer;
        Ok(self.status_locked(&runtime))
    }

    /// 指定された実データディレクトリを、次回起動時の保存先として予約する。
    fn schedule_directory(&self, target_directory: PathBuf) -> Result<StorageStatus, String> {
        self.ensure_process_lock()?;
        let mut runtime = self.lock_runtime()?;
        if let Some(reason) = &runtime.blocked_reason {
            return Err(format!(
                "保存先が利用できないため変更を予約できません: {reason}"
            ));
        }
        if runtime.pointer.cleanup_directory.is_some() {
            return Err("旧保存先の片付けが未完了です。再試行してから変更してください".to_string());
        }
        let active_directory = self.active_directory(&runtime.pointer);
        if same_existing_path(&active_directory, &target_directory) {
            return Ok(self.status_locked(&runtime));
        }
        match fs::symlink_metadata(&target_directory) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => {
                return Err(format!(
                    "移行先がフォルダではありません: {}",
                    target_directory.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("移行先を確認できません: {error}")),
        }
        let write_probe_directory = if target_directory.exists() {
            target_directory.as_path()
        } else {
            target_directory
                .parent()
                .ok_or_else(|| "移行先の親フォルダが不正です".to_string())?
        };
        verify_writable_directory(write_probe_directory)?;

        let mut next_pointer = runtime.pointer.clone();
        next_pointer.pending_directory = Some(target_directory);
        next_pointer.pending_relink_existing = false;
        write_pointer_atomic(&self.pointer_file, &next_pointer)?;
        runtime.pointer = next_pointer;
        Ok(self.status_locked(&runtime))
    }

    /// 保留中の保存先変更を取り消し、現在の保存先を維持する。
    pub fn cancel_change(&self) -> Result<StorageStatus, String> {
        self.ensure_process_lock()?;
        let mut runtime = self.lock_runtime()?;
        if runtime.pointer.pending_directory.is_none() {
            return Ok(self.status_locked(&runtime));
        }
        let mut next_pointer = runtime.pointer.clone();
        next_pointer.pending_directory = None;
        next_pointer.pending_relink_existing = false;
        write_pointer_atomic(&self.pointer_file, &next_pointer)?;
        runtime.pointer = next_pointer;
        Ok(self.status_locked(&runtime))
    }

    /// ユーザーが指定した既存のデータフォルダへ保存先ポインタを付け替える。
    pub fn relink_existing(&self, data_directory: &str) -> Result<PathBuf, String> {
        self.ensure_process_lock()?;
        let data_directory = canonical_directory(data_directory)?;
        validate_existing_data_directory(&data_directory)?;

        let mut runtime = self.lock_runtime()?;
        let mut next_pointer = StoragePointer {
            version: pointer_version(),
            active_directory: if same_existing_path(&data_directory, &self.default_directory) {
                None
            } else {
                Some(data_directory.clone())
            },
            pending_directory: None,
            pending_relink_existing: false,
            cleanup_directory: None,
            cleanup_fingerprints: BTreeMap::new(),
        };
        write_pointer_atomic(&self.pointer_file, &next_pointer)?;
        runtime.pointer_error = None;
        runtime.blocked_reason = None;
        runtime.pointer = std::mem::replace(&mut next_pointer, StoragePointer::default());
        Ok(data_directory)
    }

    /// 起動状態を失わずに内部ロックを取得する。
    fn lock_runtime(&self) -> Result<MutexGuard<'_, RuntimeStorageState>, String> {
        self.runtime
            .lock()
            .map_err(|_| "保存先の状態を確認できません".to_string())
    }

    /// 設定・DBを扱う別インスタンスとの競合を避けるため、プロセス排他を確保する。
    fn ensure_process_lock(&self) -> Result<(), String> {
        let mut process_lock = self
            .process_lock
            .lock()
            .map_err(|_| "保存先プロセスの排他状態を確認できません".to_string())?;
        if process_lock.is_some() {
            return Ok(());
        }
        let lock_file = acquire_process_lock(&process_lock_path(&self.default_directory))?;
        *process_lock = Some(lock_file);
        Ok(())
    }

    /// ポインタがないときは AppData を現在の保存先とする。
    fn active_directory(&self, pointer: &StoragePointer) -> PathBuf {
        pointer
            .active_directory
            .clone()
            .unwrap_or_else(|| self.default_directory.clone())
    }

    /// JSON 化に使う保存先状態を組み立てる。
    fn status_locked(&self, runtime: &RuntimeStorageState) -> StorageStatus {
        StorageStatus {
            active_directory: display_path(&self.active_directory(&runtime.pointer)),
            default_directory: display_path(&self.default_directory),
            pending_directory: runtime
                .pointer
                .pending_directory
                .as_ref()
                .map(|directory| display_path(directory)),
            blocked_reason: runtime.blocked_reason.clone(),
            cleanup_pending: runtime.pointer.cleanup_directory.is_some(),
        }
    }
}

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

#[cfg(test)]
pub(super) mod test_support {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::process_lock_path;

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

#[cfg(test)]
mod tests {
    use super::test_support::{create_project_tree_database, TestDirectory};
    use super::*;
    use rusqlite::Connection;
    use std::fs;

    /// コピー衝突は保留ポインタと移行元を残し、異なる移行先を上書きしない。
    #[test]
    fn failed_pending_migration_keeps_pointer_and_source() {
        let test_directory = TestDirectory::new();
        let default_directory = test_directory.path().join("default");
        let target_directory = test_directory
            .path()
            .join("custom")
            .join(APP_DATA_DIRECTORY);
        fs::create_dir_all(&default_directory).unwrap();
        fs::create_dir_all(&target_directory).unwrap();
        let source_bytes = br#"{"source":true}"#;
        let target_bytes = br#"{"target":true}"#;
        fs::write(default_directory.join(PREFERENCES_FILE), source_bytes).unwrap();
        fs::write(target_directory.join(PREFERENCES_FILE), target_bytes).unwrap();

        let pointer_file = default_directory.join(POINTER_FILE);
        let pointer = StoragePointer {
            version: pointer_version(),
            active_directory: None,
            pending_directory: Some(target_directory.clone()),
            pending_relink_existing: false,
            cleanup_directory: None,
            cleanup_fingerprints: BTreeMap::new(),
        };
        write_pointer_atomic(&pointer_file, &pointer).unwrap();
        let state = StorageLocationState::new(default_directory.clone());

        assert!(state.bootstrap().is_err());
        let persisted = read_pointer(&pointer_file).unwrap();
        assert_eq!(persisted.pending_directory, Some(target_directory.clone()));
        assert_eq!(
            fs::read(default_directory.join(PREFERENCES_FILE)).unwrap(),
            source_bytes
        );
        assert_eq!(
            fs::read(target_directory.join(PREFERENCES_FILE)).unwrap(),
            target_bytes
        );
    }

    /// 消失した custom DB は新規作成せず、再指定が必要な状態として返す。
    #[test]
    fn missing_custom_database_blocks_without_creating_an_empty_database() {
        let test_directory = TestDirectory::new();
        let default_directory = test_directory.path().join("default");
        let custom_directory = test_directory
            .path()
            .join("custom")
            .join(APP_DATA_DIRECTORY);
        fs::create_dir_all(&custom_directory).unwrap();
        let pointer_file = default_directory.join(POINTER_FILE);
        let pointer = StoragePointer {
            version: pointer_version(),
            active_directory: Some(custom_directory.clone()),
            pending_directory: None,
            pending_relink_existing: false,
            cleanup_directory: None,
            cleanup_fingerprints: BTreeMap::new(),
        };
        write_pointer_atomic(&pointer_file, &pointer).unwrap();
        let state = StorageLocationState::new(default_directory);

        let error = state.bootstrap().unwrap_err();

        assert!(error.contains("プロジェクト DB がありません"));
        assert!(!custom_directory.join(PROJECT_TREE_FILE).exists());
    }

    /// 既存 custom 保存先が移行前に消えた場合、保留ポインタを維持して移行を止める。
    #[test]
    fn pending_migration_blocks_when_custom_source_directory_or_database_disappears() {
        for remove_directory in [false, true] {
            let test_directory = TestDirectory::new();
            let default_directory = test_directory.path().join("default");
            let custom_directory = test_directory.path().join("custom");
            let selected_parent = test_directory.path().join("next");
            fs::create_dir_all(&custom_directory).unwrap();
            fs::create_dir_all(&selected_parent).unwrap();
            create_project_tree_database(&custom_directory.join(PROJECT_TREE_FILE));
            let canonical_custom_directory = fs::canonicalize(&custom_directory).unwrap();

            let state = StorageLocationState::new(default_directory.clone());
            state
                .relink_existing(canonical_custom_directory.to_str().unwrap())
                .unwrap();
            state
                .schedule_change(selected_parent.to_str().unwrap())
                .unwrap();

            if remove_directory {
                fs::remove_dir_all(&custom_directory).unwrap();
            } else {
                fs::remove_file(custom_directory.join(PROJECT_TREE_FILE)).unwrap();
            }

            assert!(state.bootstrap().is_err());
            let persisted = read_pointer(&default_directory.join(POINTER_FILE)).unwrap();
            assert_eq!(persisted.active_directory, Some(canonical_custom_directory));
            assert_eq!(
                persisted.pending_directory,
                Some(
                    fs::canonicalize(&selected_parent)
                        .unwrap()
                        .join(APP_DATA_DIRECTORY)
                )
            );
            assert!(!selected_parent
                .join(APP_DATA_DIRECTORY)
                .join(PROJECT_TREE_FILE)
                .exists());
        }
    }

    /// 任意の SQLite ファイルを既存 project-tree 保存先として採用しない。
    #[test]
    fn relink_rejects_sqlite_database_without_project_tree_schema_before_pointer_change() {
        let test_directory = TestDirectory::new();
        let default_directory = test_directory.path().join("default");
        let custom_directory = test_directory.path().join("custom");
        fs::create_dir_all(&custom_directory).unwrap();
        Connection::open(custom_directory.join(PROJECT_TREE_FILE))
            .unwrap()
            .execute_batch("CREATE TABLE unrelated(value TEXT);")
            .unwrap();
        let state = StorageLocationState::new(default_directory.clone());

        assert!(state
            .schedule_relink_existing(custom_directory.to_str().unwrap())
            .unwrap_err()
            .contains("スキーマが対応していません"));
        assert!(state
            .relink_existing(custom_directory.to_str().unwrap())
            .unwrap_err()
            .contains("スキーマが対応していません"));
        assert!(read_pointer(&default_directory.join(POINTER_FILE))
            .unwrap()
            .active_directory
            .is_none());
    }

    /// 元 DB がない初回移行でも、ポインタ確定前に新しい DB を準備する。
    #[test]
    fn first_custom_bootstrap_prepares_database_before_switching_pointer() {
        let test_directory = TestDirectory::new();
        let default_directory = test_directory.path().join("default");
        let selected_parent = test_directory.path().join("selected");
        fs::create_dir_all(&default_directory).unwrap();
        fs::create_dir_all(&selected_parent).unwrap();
        fs::write(default_directory.join(PREFERENCES_FILE), b"prefs").unwrap();
        let state = StorageLocationState::new(default_directory);
        state
            .schedule_change(selected_parent.to_str().unwrap())
            .unwrap();
        drop(state);
        let state = StorageLocationState::new(test_directory.path().join("default"));

        let active_directory = state.bootstrap().unwrap();

        assert_eq!(
            active_directory,
            fs::canonicalize(selected_parent.join(APP_DATA_DIRECTORY)).unwrap()
        );
        assert!(active_directory.join(PROJECT_TREE_FILE).is_file());
        crate::project_tree::validate_database_file(&active_directory.join(PROJECT_TREE_FILE))
            .unwrap();
    }

    /// 初回移行中に DB 準備後・ポインタ切替前で中断しても、次回起動で安全に再開できる。
    #[test]
    fn initial_migration_reuses_its_empty_database_after_interruption() {
        let test_directory = TestDirectory::new();
        let default_directory = test_directory.path().join("default");
        let selected_parent = test_directory.path().join("selected");
        fs::create_dir_all(&default_directory).unwrap();
        fs::create_dir_all(&selected_parent).unwrap();
        fs::write(default_directory.join(PREFERENCES_FILE), b"prefs").unwrap();
        let state = StorageLocationState::new(default_directory.clone());
        state
            .schedule_change(selected_parent.to_str().unwrap())
            .unwrap();
        drop(state);

        // ファイル複製と新規 DB 準備の直後にプロセスが終了した状態を再現する。
        let target_directory = selected_parent.join(APP_DATA_DIRECTORY);
        migrate_data_files(&default_directory, &target_directory).unwrap();
        ensure_project_tree_database(&target_directory.join(PROJECT_TREE_FILE)).unwrap();

        let restarted_state = StorageLocationState::new(default_directory.clone());
        let active_directory = restarted_state.bootstrap().unwrap();
        assert_eq!(
            active_directory,
            fs::canonicalize(&target_directory).unwrap()
        );
        assert!(crate::project_tree::validate_database_file(
            &active_directory.join(PROJECT_TREE_FILE)
        )
        .is_ok());
        drop(restarted_state);

        let next_restart = StorageLocationState::new(default_directory);
        assert_eq!(next_restart.bootstrap().unwrap(), active_directory);
    }

    /// 保存先再指定は既存 DB をコピーせず、現在のデータも削除しない。
    #[test]
    fn pending_relink_uses_existing_data_without_copying_or_cleaning_source() {
        let test_directory = TestDirectory::new();
        let default_directory = test_directory.path().join("default");
        let custom_directory = test_directory.path().join("custom");
        fs::create_dir_all(&default_directory).unwrap();
        fs::create_dir_all(&custom_directory).unwrap();
        fs::write(
            default_directory.join(PREFERENCES_FILE),
            b"current app data",
        )
        .unwrap();
        create_project_tree_database(&custom_directory.join(PROJECT_TREE_FILE));
        let state = StorageLocationState::new(default_directory.clone());
        state
            .schedule_relink_existing(custom_directory.to_str().unwrap())
            .unwrap();

        let active_directory = state.bootstrap().unwrap();

        assert_eq!(
            active_directory,
            fs::canonicalize(custom_directory).unwrap()
        );
        assert_eq!(
            fs::read(default_directory.join(PREFERENCES_FILE)).unwrap(),
            b"current app data"
        );
        assert!(!active_directory.join(PREFERENCES_FILE).exists());
        assert!(!state.status().unwrap().cleanup_pending);
        state.confirm_startup().unwrap();
        assert_eq!(
            fs::read(default_directory.join(PREFERENCES_FILE)).unwrap(),
            b"current app data"
        );
    }

    /// 切替後に元ファイルが変化していた場合、クリーンアップでそのファイルを削除しない。
    #[test]
    fn changed_source_file_is_preserved_during_cleanup() {
        let test_directory = TestDirectory::new();
        let default_directory = test_directory.path().join("default");
        let selected_parent = test_directory.path().join("selected");
        fs::create_dir_all(&default_directory).unwrap();
        fs::create_dir_all(&selected_parent).unwrap();
        let source_file = default_directory.join(PREFERENCES_FILE);
        fs::write(&source_file, b"before migration").unwrap();
        let state = StorageLocationState::new(default_directory);
        state
            .schedule_change(selected_parent.to_str().unwrap())
            .unwrap();
        state.bootstrap().unwrap();
        fs::write(&source_file, b"written by another process").unwrap();

        assert!(state.confirm_startup().is_err());
        assert_eq!(
            fs::read(source_file).unwrap(),
            b"written by another process"
        );
        assert!(state.status().unwrap().cleanup_pending);
    }

    /// 明示的な後片付け解除は旧ファイルを残し、ポインタ上の予約だけを消す。
    #[test]
    fn abandoning_cleanup_keeps_legacy_data_untouched() {
        let test_directory = TestDirectory::new();
        let default_directory = test_directory.path().join("default");
        let selected_parent = test_directory.path().join("selected");
        fs::create_dir_all(&default_directory).unwrap();
        fs::create_dir_all(&selected_parent).unwrap();
        let old_preferences = default_directory.join(PREFERENCES_FILE);
        fs::write(&old_preferences, b"old preferences").unwrap();
        let state = StorageLocationState::new(default_directory.clone());
        state
            .schedule_change(selected_parent.to_str().unwrap())
            .unwrap();
        let active_directory = state.bootstrap().unwrap();
        assert!(state.status().unwrap().cleanup_pending);

        let status = state.abandon_cleanup().unwrap();

        assert!(!status.cleanup_pending);
        assert_eq!(fs::read(old_preferences).unwrap(), b"old preferences");
        let pointer = read_pointer(&default_directory.join(POINTER_FILE)).unwrap();
        assert!(pointer.cleanup_directory.is_none());
        assert!(pointer.cleanup_fingerprints.is_empty());
        assert_eq!(pointer.active_directory, Some(active_directory));
        assert!(!state.abandon_cleanup().unwrap().cleanup_pending);
    }
}
