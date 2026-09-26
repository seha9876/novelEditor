//! 保存先の共通パス、データファイル名、一時ファイル名を管理する。

use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) const POINTER_FILE: &str = "storage-location.json";
pub(super) const APP_DATA_DIRECTORY: &str = "novelEditor-data";
pub(super) const PREFERENCES_FILE: &str = "preferences.json";
pub(super) const PROJECT_TREE_FILE: &str = "project-tree.sqlite3";
pub(super) const RECOVERY_FILE: &str = "recovery.json";
pub(super) const DATA_FILES: [&str; 3] = [PREFERENCES_FILE, PROJECT_TREE_FILE, RECOVERY_FILE];

static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 既存パス同士は canonical path で比較し、作成前のパスはそのまま比較する。
pub(super) fn same_existing_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
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
