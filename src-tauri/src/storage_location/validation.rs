//! 保存先ディレクトリの正規化、存在確認、書込可否を検証する。

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use super::pointer::temporary_path;
use super::PROJECT_TREE_FILE;

/// 指定フォルダへ一時ファイルを作成・削除し、移行に必要な書込権限を確認する。
pub(super) fn verify_writable_directory(directory: &Path) -> Result<(), String> {
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
pub(super) fn canonical_directory(path: &str) -> Result<PathBuf, String> {
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
pub(super) fn validate_existing_data_directory(directory: &Path) -> Result<(), String> {
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
