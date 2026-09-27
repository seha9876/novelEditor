//! 保存先を同時に扱うプロセス排他を管理する。

use std::{
    fs::{self, File, OpenOptions},
    path::Path,
};

use sha2::{Digest, Sha256};

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

/// Data directory ごとに区別した OS 一時フォルダのプロセスロックパスを作る。
pub(super) fn process_lock_path(default_directory: &Path) -> std::path::PathBuf {
    let digest = Sha256::digest(default_directory.to_string_lossy().as_bytes());
    std::env::temp_dir().join(format!("novel-editor-storage-{:x}.lock", digest))
}

#[cfg(test)]
mod tests {
    use super::super::{state::StorageLocationState, test_support::TestDirectory};

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
