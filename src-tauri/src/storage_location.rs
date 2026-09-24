//! アプリ設定、プロジェクト DB、復元データの保存先を管理する。

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{backup::Backup, types::Value, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{State, Window};
use tauri_plugin_fs::FsExt;

use crate::project_tree::ProjectTreeState;

const POINTER_FILE: &str = "storage-location.json";
const APP_DATA_DIRECTORY: &str = "novelEditor-data";
const PREFERENCES_FILE: &str = "preferences.json";
const PROJECT_TREE_FILE: &str = "project-tree.sqlite3";
const RECOVERY_FILE: &str = "recovery.json";
const DATA_FILES: [&str; 3] = [PREFERENCES_FILE, PROJECT_TREE_FILE, RECOVERY_FILE];

static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

/// AppData 内に置く保存先ポインタ。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoragePointer {
    #[serde(default = "pointer_version")]
    version: u32,
    #[serde(default)]
    active_directory: Option<PathBuf>,
    #[serde(default)]
    pending_directory: Option<PathBuf>,
    #[serde(default)]
    pending_relink_existing: bool,
    #[serde(default)]
    cleanup_directory: Option<PathBuf>,
    #[serde(default)]
    cleanup_fingerprints: BTreeMap<String, String>,
}

impl Default for StoragePointer {
    fn default() -> Self {
        Self {
            version: pointer_version(),
            active_directory: None,
            pending_directory: None,
            pending_relink_existing: false,
            cleanup_directory: None,
            cleanup_fingerprints: BTreeMap::new(),
        }
    }
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

/// AppData ポインタを読み込む。不在は初期状態として扱う。
fn read_pointer(pointer_file: &Path) -> Result<StoragePointer, String> {
    let bytes = match fs::read(pointer_file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StoragePointer::default());
        }
        Err(error) => return Err(format!("保存先ポインタを読み込めません: {error}")),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "保存先ポインタを解析できません ({}): {error}",
            pointer_file.display()
        )
    })?;
    let fields = value
        .as_object()
        .ok_or_else(|| format!("保存先ポインタの形式が不正です: {}", pointer_file.display()))?;
    for field in [
        "version",
        "activeDirectory",
        "pendingDirectory",
        "pendingRelinkExisting",
        "cleanupDirectory",
        "cleanupFingerprints",
    ] {
        if !fields.contains_key(field) {
            return Err(format!(
                "保存先ポインタの項目が不足しています ({field}): {}",
                pointer_file.display()
            ));
        }
    }
    let pointer: StoragePointer = serde_json::from_value(value).map_err(|error| {
        format!(
            "保存先ポインタを解析できません ({}): {error}",
            pointer_file.display()
        )
    })?;
    if pointer.version != pointer_version() {
        return Err(format!(
            "未対応の保存先ポインタ形式です: version {}",
            pointer.version
        ));
    }
    if pointer.pending_relink_existing && pointer.pending_directory.is_none() {
        return Err(format!(
            "保存先ポインタの予約状態が不正です: {}",
            pointer_file.display()
        ));
    }
    if pointer.cleanup_directory.is_some() != !pointer.cleanup_fingerprints.is_empty() {
        return Err(format!(
            "保存先ポインタの片付け状態が不正です: {}",
            pointer_file.display()
        ));
    }
    for directory in [
        pointer.active_directory.as_ref(),
        pointer.pending_directory.as_ref(),
        pointer.cleanup_directory.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if !directory.is_absolute() {
            return Err(format!(
                "保存先ポインタに相対パスがあります: {}",
                pointer_file.display()
            ));
        }
    }
    for (file_name, fingerprint) in &pointer.cleanup_fingerprints {
        if !DATA_FILES.contains(&file_name.as_str())
            || fingerprint.len() != 64
            || !fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(format!(
                "保存先ポインタの検証情報が不正です: {}",
                pointer_file.display()
            ));
        }
    }
    Ok(pointer)
}

/// ポインタを一時ファイルへ書いてから置換し、途中書き込みを有効な設定として扱わない。
fn write_pointer_atomic(pointer_file: &Path, pointer: &StoragePointer) -> Result<(), String> {
    let parent = pointer_file
        .parent()
        .ok_or_else(|| "保存先ポインタの場所が不正です".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("AppData を作成できません: {error}"))?;
    let temporary_path = temporary_path(pointer_file, "pointer");
    let bytes = serde_json::to_vec_pretty(pointer)
        .map_err(|error| format!("保存先ポインタを作成できません: {error}"))?;
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|error| format!("保存先ポインタの一時ファイルを作成できません: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("保存先ポインタを書き込めません: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("保存先ポインタを同期できません: {error}"))?;
        fs::rename(&temporary_path, pointer_file)
            .map_err(|error| format!("保存先ポインタを更新できません: {error}"))?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    write_result
}

/// AppData のファイルロックを保持し、二重起動による移行・片付けの競合を防ぐ。
fn acquire_process_lock(lock_path: &Path) -> Result<File, String> {
    let parent = lock_path
        .parent()
        .ok_or_else(|| "保存先ロックの場所が不正です".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("AppData を作成できません: {error}"))?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(lock_path)
        .map_err(|error| format!("保存先ロックを開けません: {error}"))?;
    file.try_lock().map_err(|error| {
        format!(
            "別のアプリインスタンスが保存データを使用中です。閉じてから再試行してください: {error}"
        )
    })?;
    Ok(file)
}

/// source に存在する3ファイルだけを、既存ファイルを上書きせず target へ複製する。
fn migrate_data_files(source_directory: &Path, target_directory: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(source_directory) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(format!(
                "移行元が通常のフォルダではありません: {}",
                source_directory.display()
            ));
        }
    }
    match fs::symlink_metadata(target_directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => {
            return Err(format!(
                "移行先が通常のフォルダではありません: {}",
                target_directory.display()
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(target_directory)
                .map_err(|error| format!("移行先フォルダを作成できません: {error}"))?;
        }
        Err(error) => return Err(format!("移行先フォルダを確認できません: {error}")),
    }

    for file_name in DATA_FILES {
        let source_path = source_directory.join(file_name);
        let target_path = target_directory.join(file_name);
        let source_metadata = match fs::symlink_metadata(&source_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match fs::symlink_metadata(&target_path) {
                    Ok(_) => {
                        if file_name == PROJECT_TREE_FILE
                            && crate::project_tree::is_empty_database_file(&target_path)?
                        {
                            // 初回移行がポインタ確定前に中断した場合、空の新規 DB だけ再利用する。
                            continue;
                        }
                        return Err(format!(
                            "移行先に移行元にはない同名ファイルがあります。上書きせず停止しました: {}",
                            target_path.display()
                        ));
                    }
                    Err(target_error) if target_error.kind() == std::io::ErrorKind::NotFound => {
                        continue;
                    }
                    Err(target_error) => {
                        return Err(format!(
                            "移行先ファイルを確認できません ({}): {target_error}",
                            target_path.display()
                        ));
                    }
                }
            }
            Err(error) => {
                return Err(format!(
                    "移行元を確認できません ({}): {error}",
                    source_path.display()
                ))
            }
        };
        if !source_metadata.file_type().is_file() {
            return Err(format!(
                "移行元が通常ファイルではありません: {}",
                source_path.display()
            ));
        }

        match fs::symlink_metadata(&target_path) {
            Ok(metadata) => {
                if !metadata.file_type().is_file()
                    || !data_files_match(file_name, &source_path, &target_path)?
                {
                    return Err(format!(
                        "移行先に異なる同名ファイルがあります。上書きしません: {}",
                        target_path.display()
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                copy_data_file(file_name, &source_path, &target_path)?;
                if !data_files_match(file_name, &source_path, &target_path)? {
                    let _ = fs::remove_file(&target_path);
                    return Err(format!(
                        "移行先の検証に失敗しました: {}",
                        target_path.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!(
                    "移行先ファイルを確認できません ({}): {error}",
                    target_path.display()
                ))
            }
        }
    }
    Ok(())
}

/// JSON ファイルはバイト列、SQLite は DB 内容を比較して移行の再試行を判定する。
fn data_files_match(file_name: &str, source: &Path, target: &Path) -> Result<bool, String> {
    if file_name == PROJECT_TREE_FILE {
        return sqlite_contents_match(source, target);
    }
    let source_bytes = fs::read(source)
        .map_err(|error| format!("移行元を読み込めません ({}): {error}", source.display()))?;
    let target_bytes = fs::read(target)
        .map_err(|error| format!("移行先を読み込めません ({}): {error}", target.display()))?;
    Ok(source_bytes == target_bytes)
}

/// SQLite Backup API で一時 DB に複製してから、移行先へ原子的に配置する。
fn copy_data_file(file_name: &str, source: &Path, target: &Path) -> Result<(), String> {
    let temporary_path = temporary_path(target, "migration");
    let result = if file_name == PROJECT_TREE_FILE {
        backup_database(source, &temporary_path)
    } else {
        copy_file_to_temporary(source, &temporary_path)
    };
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }

    let install_result = install_temporary_file(&temporary_path, target);
    if install_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    install_result
}

/// SQLite Backup API を使い、複製後に integrity_check を通す。
fn backup_database(source: &Path, temporary_target: &Path) -> Result<(), String> {
    let source_connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("SQLite 移行元を開けません: {error}"))?;
    let mut target_connection = Connection::open(temporary_target)
        .map_err(|error| format!("SQLite 一時 DB を作成できません: {error}"))?;
    {
        let backup = Backup::new(&source_connection, &mut target_connection)
            .map_err(|error| format!("SQLite バックアップを開始できません: {error}"))?;
        backup
            .run_to_completion(64, Duration::from_millis(5), None)
            .map_err(|error| format!("SQLite をバックアップできません: {error}"))?;
    }
    let integrity: String = target_connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("SQLite 移行先を検証できません: {error}"))?;
    if integrity != "ok" {
        return Err(format!(
            "SQLite 移行先の整合性検査に失敗しました: {integrity}"
        ));
    }
    drop(target_connection);
    drop(source_connection);
    Ok(())
}

/// JSON ファイルを同じ移行先フォルダ内の一時ファイルへ同期して書き込む。
fn copy_file_to_temporary(source: &Path, temporary_target: &Path) -> Result<(), String> {
    let bytes = fs::read(source)
        .map_err(|error| format!("移行元を読み込めません ({}): {error}", source.display()))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary_target)
        .map_err(|error| format!("一時ファイルを作成できません: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("一時ファイルへ書き込めません: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("一時ファイルを同期できません: {error}"))
}

/// 移行先に既存ファイルがない場合だけ一時ファイルを確定する。
fn install_temporary_file(temporary_path: &Path, target_path: &Path) -> Result<(), String> {
    if target_path.exists() {
        return Err(format!(
            "移行先ファイルが既にあります: {}",
            target_path.display()
        ));
    }
    match fs::hard_link(temporary_path, target_path) {
        Ok(()) => {
            fs::remove_file(temporary_path)
                .map_err(|error| format!("移行一時ファイルを片付けられません: {error}"))?;
            Ok(())
        }
        Err(hard_link_error) => {
            if target_path.exists() {
                return Err(format!(
                    "移行先ファイルが既にあります: {}",
                    target_path.display()
                ));
            }
            fs::rename(temporary_path, target_path).map_err(|rename_error| {
                format!(
                    "移行先へファイルを確定できません (hard link: {hard_link_error}; rename: {rename_error})"
                )
            })
        }
    }
}

/// SQLite のスキーマとテーブル内容が一致するか調べ、中断移行の同一 DB を判定する。
fn sqlite_contents_match(source: &Path, target: &Path) -> Result<bool, String> {
    let source_connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("SQLite 移行元を開けません: {error}"))?;
    let target_connection = Connection::open_with_flags(target, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("SQLite 移行先を開けません: {error}"))?;
    let source_integrity = integrity_check(&source_connection)?;
    let target_integrity = integrity_check(&target_connection)?;
    if source_integrity != "ok" || target_integrity != "ok" {
        return Ok(false);
    }
    Ok(database_contents(&source_connection)? == database_contents(&target_connection)?)
}

/// SQLite の論理内容を、表定義・全行・autoincrement 状態の順に取得する。
fn database_contents(connection: &Connection) -> Result<DatabaseContents, String> {
    let mut object_statement = connection
        .prepare(
            "SELECT type, name, sql FROM sqlite_master
             WHERE type IN ('table', 'index', 'trigger', 'view')
               AND name NOT LIKE 'sqlite_%'
             ORDER BY type, name",
        )
        .map_err(|error| format!("SQLite スキーマを読み込めません: {error}"))?;
    let objects = object_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| format!("SQLite スキーマを取得できません: {error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("SQLite スキーマを読み込めません: {error}"))?;

    let mut tables = Vec::new();
    for (kind, name, _) in &objects {
        if kind != "table" {
            continue;
        }
        let escaped_name = name.replace('"', "\"\"");
        let mut statement = connection
            .prepare(&format!("SELECT * FROM \"{escaped_name}\" ORDER BY rowid"))
            .map_err(|error| format!("SQLite テーブルを読み込めません ({name}): {error}"))?;
        let column_count = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                (0..column_count)
                    .map(|index| row.get::<_, Value>(index))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|error| format!("SQLite テーブルを取得できません ({name}): {error}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("SQLite テーブルを読み込めません ({name}): {error}"))?;
        tables.push((name.clone(), rows));
    }

    let sequence = match connection.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name") {
        Ok(mut statement) => statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| format!("SQLite ID 採番状態を取得できません: {error}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("SQLite ID 採番状態を読み込めません: {error}"))?,
        Err(rusqlite::Error::SqliteFailure(error, _))
            if error.code == rusqlite::ErrorCode::Unknown =>
        {
            Vec::new()
        }
        Err(error) => return Err(format!("SQLite ID 採番状態を確認できません: {error}")),
    };

    Ok(DatabaseContents {
        objects,
        tables,
        sequence,
    })
}

/// DB が読み取り可能で整合しているかを調べる。
fn integrity_check(connection: &Connection) -> Result<String, String> {
    connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("SQLite 整合性を検査できません: {error}"))
}

#[derive(Debug, PartialEq)]
struct DatabaseContents {
    objects: Vec<(String, String, Option<String>)>,
    tables: Vec<(String, Vec<Vec<Value>>)>,
    sequence: Vec<(String, i64)>,
}

/// 移行元の対象ファイルを SHA-256 で記録し、移行後に外部変更を検知する。
fn fingerprint_data_files(directory: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut fingerprints = BTreeMap::new();
    for file_name in DATA_FILES {
        let file_path = directory.join(file_name);
        match fs::symlink_metadata(&file_path) {
            Ok(metadata) if metadata.file_type().is_file() => {
                fingerprints.insert(file_name.to_string(), fingerprint_file(&file_path)?);
            }
            Ok(_) => {
                return Err(format!(
                    "保存データが通常ファイルではありません: {}",
                    file_path.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("保存データを確認できません: {error}")),
        }
    }
    Ok(fingerprints)
}

/// SQLite が大きくても全体をメモリへ読み込まず fingerprint を計算する。
fn fingerprint_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("ファイルを検証用に開けません ({}): {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("ファイルを検証できません ({}): {error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

/// 指定フォルダへ一時ファイルを作成・削除し、移行に必要な書込権限を確認する。
fn verify_writable_directory(directory: &Path) -> Result<(), String> {
    let probe_path = temporary_path(&directory.join("storage-write-probe"), "permission-check");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe_path)
        .map_err(|error| format!("保存先へ書き込めません ({}): {error}", directory.display()))?;
    let write_result = file
        .write_all(b"storage write test")
        .and_then(|()| file.sync_all());
    drop(file);
    let remove_result = fs::remove_file(&probe_path);
    write_result.map_err(|error| {
        format!(
            "保存先への書込を検証できません ({}): {error}",
            directory.display()
        )
    })?;
    remove_result.map_err(|error| {
        format!(
            "保存先の検査ファイルを削除できません ({}): {error}",
            probe_path.display()
        )
    })
}

/// フォルダ選択結果を既存の実ディレクトリに正規化する。
fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    let directory = fs::canonicalize(path)
        .map_err(|error| format!("指定フォルダを確認できません ({}): {error}", path.display()))?;
    if !directory.is_dir() {
        return Err(format!(
            "指定先がフォルダではありません: {}",
            directory.display()
        ));
    }
    Ok(directory)
}

/// 既存保存先として使うには、利用可能な既存プロジェクト DB が必要。
fn validate_existing_data_directory(directory: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(directory).map_err(|error| {
        format!(
            "既存データフォルダを確認できません ({}): {error}",
            directory.display()
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "既存データ先が通常のフォルダではありません: {}",
            directory.display()
        ));
    }
    let database_path = directory.join(PROJECT_TREE_FILE);
    let database_metadata = fs::symlink_metadata(&database_path).map_err(|error| {
        format!(
            "既存データフォルダにプロジェクト DB がありません ({}): {error}",
            database_path.display()
        )
    })?;
    if !database_metadata.file_type().is_file() {
        return Err(format!(
            "既存データフォルダのプロジェクト DB が通常ファイルではありません: {}",
            database_path.display()
        ));
    }
    crate::project_tree::validate_database_file(&database_path)
}

/// 保存先の初回起動では空 DB を原子的に準備し、再起動時も安全に再利用できるようにする。
fn ensure_project_tree_database(database_path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(database_path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            crate::project_tree::validate_database_file(database_path)
        }
        Ok(_) => Err(format!(
            "プロジェクトツリー DB が通常ファイルではありません: {}",
            database_path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let temporary_path = temporary_path(database_path, "new-database");
            if let Err(error) = crate::project_tree::prepare_new_database_file(&temporary_path) {
                let _ = fs::remove_file(&temporary_path);
                return Err(error);
            }
            if let Err(error) = install_temporary_file(&temporary_path, database_path) {
                let _ = fs::remove_file(&temporary_path);
                if crate::project_tree::is_empty_database_file(database_path).unwrap_or(false) {
                    return Ok(());
                }
                return Err(error);
            }
            crate::project_tree::validate_database_file(database_path)
        }
        Err(error) => Err(format!(
            "プロジェクトツリー DB を確認できません ({}): {error}",
            database_path.display()
        )),
    }
}

/// 既存パス同士は canonical path で比較し、作成前のパスはそのまま比較する。
fn same_existing_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// Data directory ごとに区別した OS 一時フォルダのプロセスロックパスを作る。
fn process_lock_path(default_directory: &Path) -> PathBuf {
    let digest = Sha256::digest(default_directory.to_string_lossy().as_bytes());
    std::env::temp_dir().join(format!("novel-editor-storage-{:x}.lock", digest))
}

/// Windows の拡張長パス接頭辞を表示用文字列から取り除く。
fn display_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc_path) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc_path}");
        }
        if let Some(ordinary_path) = path.strip_prefix(r"\\?\") {
            return ordinary_path.to_string();
        }
    }
    path.into_owned()
}

/// 一時ファイル名の衝突を避ける。
fn temporary_path(target: &Path, purpose: &str) -> PathBuf {
    let sequence = TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("storage");
    target.with_file_name(format!(
        ".{file_name}.{purpose}-{}-{timestamp}-{sequence}.tmp",
        std::process::id(),
    ))
}

fn pointer_version() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let sequence = TEST_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "novel-editor-storage-test-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
            let _ = fs::remove_file(process_lock_path(&self.0.join("default")));
        }
    }

    /// DB の移行結果を検証するため、小さく識別可能なテーブルを作る。
    fn create_test_database(path: &Path) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE documents(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
                 CREATE INDEX documents_name ON documents(name);
                 INSERT INTO documents(name) VALUES ('first'), ('second');",
            )
            .unwrap();
        connection
            .execute("DELETE FROM documents WHERE id = 2", [])
            .unwrap();
        connection
            .execute("INSERT INTO documents(name) VALUES (?1)", params!["third"])
            .unwrap();
    }

    /// 保存先の再指定テスト用に空のアプリ DB を作成する。
    fn create_project_tree_database(path: &Path) {
        crate::project_tree::prepare_new_database_file(path).unwrap();
    }

    /// 各データファイルが任意に欠けていても、存在する分だけを移行できる。
    #[test]
    fn migrates_each_of_eight_file_presence_combinations() {
        for mask in 0_u8..8 {
            let test_directory = TestDirectory::new();
            let source = test_directory.path().join("source");
            let target = test_directory.path().join("target");
            fs::create_dir_all(&source).unwrap();

            if mask & 0b001 != 0 {
                fs::write(source.join(PREFERENCES_FILE), br#"{"prefs":1}"#).unwrap();
            }
            if mask & 0b010 != 0 {
                create_test_database(&source.join(PROJECT_TREE_FILE));
            }
            if mask & 0b100 != 0 {
                fs::write(source.join(RECOVERY_FILE), br#"{"snapshot":2}"#).unwrap();
            }

            migrate_data_files(&source, &target).unwrap();
            for file_name in DATA_FILES {
                assert_eq!(
                    source.join(file_name).exists(),
                    target.join(file_name).exists(),
                    "presence mismatch for mask {mask} and {file_name}"
                );
                if file_name == PROJECT_TREE_FILE && source.join(file_name).exists() {
                    assert!(sqlite_contents_match(
                        &source.join(file_name),
                        &target.join(file_name)
                    )
                    .unwrap());
                } else if source.join(file_name).exists() {
                    assert_eq!(
                        fs::read(source.join(file_name)).unwrap(),
                        fs::read(target.join(file_name)).unwrap()
                    );
                }
            }
        }
    }

    /// DB は通常接続を開く前に Backup API で複製され、論理内容が保たれる。
    #[test]
    fn sqlite_backup_preserves_database_contents() {
        let test_directory = TestDirectory::new();
        let source = test_directory.path().join(PROJECT_TREE_FILE);
        let target = test_directory.path().join("copied.sqlite3");
        create_test_database(&source);

        backup_database(&source, &target).unwrap();

        assert!(sqlite_contents_match(&source, &target).unwrap());
    }

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

    /// 移行元にない名前でも移行先に既存ファイルがあれば予約を失敗させる。
    #[test]
    fn migration_rejects_destination_file_without_source_counterpart() {
        let test_directory = TestDirectory::new();
        let source = test_directory.path().join("source");
        let target = test_directory.path().join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join(RECOVERY_FILE), b"existing recovery").unwrap();

        let error = migrate_data_files(&source, &target).unwrap_err();

        assert!(error.contains("移行元にはない同名ファイル"));
        assert_eq!(
            fs::read(target.join(RECOVERY_FILE)).unwrap(),
            b"existing recovery"
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

    /// 移行完了前にポインタを切り替えず、コピー済み同一 JSON を再試行に使える。
    #[test]
    fn identical_destination_file_is_safe_to_reuse_after_interruption() {
        let test_directory = TestDirectory::new();
        let source = test_directory.path().join("source");
        let target = test_directory.path().join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        let bytes = br#"{"same":true}"#;
        fs::write(source.join(PREFERENCES_FILE), bytes).unwrap();
        fs::write(target.join(PREFERENCES_FILE), bytes).unwrap();

        migrate_data_files(&source, &target).unwrap();

        assert_eq!(fs::read(source.join(PREFERENCES_FILE)).unwrap(), bytes);
        assert_eq!(fs::read(target.join(PREFERENCES_FILE)).unwrap(), bytes);
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

    /// 同時起動は保存データ操作を拒み、先行プロセス終了後の再試行を許可する。
    #[test]
    fn process_lock_prevents_two_instances_from_using_storage() {
        let test_directory = TestDirectory::new();
        let default_directory = test_directory.path().join("default");
        let first = StorageLocationState::new(default_directory.clone());
        first.bootstrap().unwrap();
        let second = StorageLocationState::new(default_directory);

        assert!(second
            .bootstrap()
            .unwrap_err()
            .contains("別のアプリインスタンス"));
        drop(first);
        assert!(second.bootstrap().is_ok());
    }

    /// 同じポインタの置換を繰り返してもファイルは常に解析可能な状態で残る。
    #[test]
    fn pointer_replacement_keeps_complete_json() {
        let test_directory = TestDirectory::new();
        let pointer_file = test_directory.path().join(POINTER_FILE);
        for name in ["first", "second"] {
            let active_directory = test_directory.path().join(name);
            let pointer = StoragePointer {
                version: pointer_version(),
                active_directory: Some(active_directory.clone()),
                pending_directory: None,
                pending_relink_existing: false,
                cleanup_directory: None,
                cleanup_fingerprints: BTreeMap::new(),
            };
            write_pointer_atomic(&pointer_file, &pointer).unwrap();
            assert_eq!(
                read_pointer(&pointer_file).unwrap().active_directory,
                Some(active_directory)
            );
        }
    }

    /// 不在場所以外で壊れたポインタや必須項目の欠落を既定先として扱わない。
    #[test]
    fn malformed_or_incomplete_pointer_is_rejected() {
        let test_directory = TestDirectory::new();
        let pointer_file = test_directory.path().join(POINTER_FILE);
        fs::write(&pointer_file, b"{}").unwrap();

        assert!(read_pointer(&pointer_file)
            .unwrap_err()
            .contains("項目が不足しています"));

        let mut unsupported = StoragePointer::default();
        unsupported.version = 0;
        write_pointer_atomic(&pointer_file, &unsupported).unwrap();
        assert!(read_pointer(&pointer_file)
            .unwrap_err()
            .contains("未対応の保存先ポインタ形式"));
    }
}
