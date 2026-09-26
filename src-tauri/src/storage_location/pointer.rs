//! 保存先ポインタの JSON と原子的な更新を管理する。

use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::paths::{temporary_path, DATA_FILES};

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

/// 現行の保存先ポインタ形式のバージョンを返す。
pub(super) fn pointer_version() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    use super::super::paths::POINTER_FILE;
    use super::super::test_support::TestDirectory;
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
}
