//! 保存先ポインタの JSON、原子的な更新、一重起動排他を管理する。

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::DATA_FILES;

static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// AppData 内に置く保存先ポインタ。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoragePointer {
    #[serde(default = "pointer_version")]
    pub(super) version: u32,
    #[serde(default)]
    pub(super) active_directory: Option<PathBuf>,
    #[serde(default)]
    pub(super) pending_directory: Option<PathBuf>,
    #[serde(default)]
    pub(super) pending_relink_existing: bool,
    #[serde(default)]
    pub(super) cleanup_directory: Option<PathBuf>,
    #[serde(default)]
    pub(super) cleanup_fingerprints: BTreeMap<String, String>,
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

/// AppData ポインタを読み込む。不在は初期状態として扱う。
pub(super) fn read_pointer(pointer_file: &Path) -> Result<StoragePointer, String> {
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
pub(super) fn write_pointer_atomic(
    pointer_file: &Path,
    pointer: &StoragePointer,
) -> Result<(), String> {
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
pub(super) fn acquire_process_lock(lock_path: &Path) -> Result<File, String> {
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

/// 既存パス同士は canonical path で比較し、作成前のパスはそのまま比較する。
pub(super) fn same_existing_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// Data directory ごとに区別した OS 一時フォルダのプロセスロックパスを作る。
pub(super) fn process_lock_path(default_directory: &Path) -> PathBuf {
    let digest = Sha256::digest(default_directory.to_string_lossy().as_bytes());
    std::env::temp_dir().join(format!("novel-editor-storage-{:x}.lock", digest))
}

/// Windows の拡張長パス接頭辞を表示用文字列から取り除く。
pub(super) fn display_path(path: &Path) -> String {
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
pub(super) fn temporary_path(target: &Path, purpose: &str) -> PathBuf {
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

pub(super) fn pointer_version() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    use super::super::test_support::TestDirectory;
    use super::super::{StorageLocationState, POINTER_FILE};
    use super::*;
    use std::{collections::BTreeMap, fs};

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
}
