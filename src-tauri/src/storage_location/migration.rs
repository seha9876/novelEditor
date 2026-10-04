//! 保存先データファイルの移行、原子配置、指紋計算を管理する。

use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
};

use sha2::{Digest, Sha256};

use super::paths::{temporary_path, DATA_FILES, PROJECT_TREE_FILE};

/// source に存在する3ファイルだけを、既存ファイルを上書きせず target へ複製する。
pub(super) fn migrate_data_files(
    source_directory: &Path,
    target_directory: &Path,
) -> Result<(), String> {
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
        return super::sqlite::sqlite_contents_match(source, target);
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
        super::sqlite::backup_database(source, &temporary_path)
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
pub(super) fn install_temporary_file(
    temporary_path: &Path,
    target_path: &Path,
) -> Result<(), String> {
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

/// 移行元の対象ファイルを SHA-256 で記録し、移行後に外部変更を検知する。
pub(super) fn fingerprint_data_files(directory: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut fingerprints = BTreeMap::new();
    for file_name in DATA_FILES {
        let file_path = directory.join(file_name);
        match fs::symlink_metadata(&file_path) {
            Ok(metadata) if metadata.file_type().is_file() => {
                fingerprints.insert(file_name.to_string(), fingerprint_data_file(&file_path)?);
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

/// SQLite の未チェックポイント更新も指紋に含め、DB 本体だけでは見落とす変更を検出する。
/// 補助ファイルがない場合は従来の指紋と一致させ、保存済みポインタとの互換性を保つ。
pub(super) fn fingerprint_data_file(path: &Path) -> Result<String, String> {
    let main_fingerprint = fingerprint_file(path)?;
    if path.file_name().and_then(|name| name.to_str()) != Some(PROJECT_TREE_FILE) {
        return Ok(main_fingerprint);
    }
    let mut sidecar_fingerprints = Vec::new();
    for suffix in ["-wal", "-journal"] {
        let sidecar = path.with_file_name(format!("{PROJECT_TREE_FILE}{suffix}"));
        match fs::symlink_metadata(&sidecar) {
            Ok(metadata) if metadata.file_type().is_file() => {
                // 読み取り専用の SQLite 接続でも空 WAL が作られるため、内容がある場合だけ含める。
                if metadata.len() > 0 {
                    sidecar_fingerprints.push((suffix, fingerprint_file(&sidecar)?));
                }
            }
            Ok(_) => {
                return Err(format!(
                    "SQLite 補助ファイルが通常ファイルではありません: {}",
                    sidecar.display()
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("SQLite 補助ファイルを確認できません: {error}")),
        }
    }
    if sidecar_fingerprints.is_empty() {
        return Ok(main_fingerprint);
    }
    let mut digest = Sha256::new();
    digest.update(main_fingerprint.as_bytes());
    for (suffix, fingerprint) in sidecar_fingerprints {
        digest.update(suffix.as_bytes());
        digest.update(fingerprint.as_bytes());
    }
    Ok(format!("{:x}", digest.finalize()))
}

/// SQLite の未反映更新を残すため、内容のある補助ファイルが残る間は旧 DB の削除を止める。
/// 読み取り専用接続が生成した空 WAL は更新を持たないため、片付けを妨げない。
pub(super) fn verify_sqlite_cleanup_safe(directory: &Path) -> Result<(), String> {
    for suffix in ["-wal", "-journal"] {
        let sidecar = directory.join(format!("{PROJECT_TREE_FILE}{suffix}"));
        match fs::symlink_metadata(&sidecar) {
            Ok(metadata) if metadata.file_type().is_file() && metadata.len() == 0 => {}
            Ok(_) => return Err(format!("旧データに SQLite の更新情報が残っているため削除しませんでした。使用中のアプリを閉じて再試行するか、旧データを残してください: {}", sidecar.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("旧データの SQLite 更新情報を確認できません: {error}")),
        }
    }
    Ok(())
}

/// SQLite が大きくても全体をメモリへ読み込まず fingerprint を計算する。
pub(super) fn fingerprint_file(path: &Path) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::super::paths::{DATA_FILES, PREFERENCES_FILE, PROJECT_TREE_FILE, RECOVERY_FILE};
    use super::super::sqlite::sqlite_contents_match;
    use super::super::test_support::TestDirectory;
    use super::*;
    use rusqlite::{params, Connection};
    use std::fs;

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

    /// 原稿本文を含まない履歴テーブルも、IDと並び順を保って保存先へ移す。
    #[test]
    fn migrates_recent_files_with_stable_ids_and_order() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source");
        let target = directory.path().join("target");
        crate::project_tree::prepare_new_database_file(&source.join(PROJECT_TREE_FILE)).unwrap();
        let connection = Connection::open(source.join(PROJECT_TREE_FILE)).unwrap();
        connection.execute_batch("INSERT INTO recent_files(id, path, path_key, last_used) VALUES (9, 'C:/原稿.txt', 'c:/原稿.txt', 2), (12, 'D:/原稿.txt', 'd:/原稿.txt', 1);").unwrap();
        drop(connection);
        migrate_data_files(&source, &target).unwrap();
        assert!(sqlite_contents_match(
            &source.join(PROJECT_TREE_FILE),
            &target.join(PROJECT_TREE_FILE)
        )
        .unwrap());
        assert!(
            !crate::project_tree::is_empty_database_file(&target.join(PROJECT_TREE_FILE)).unwrap()
        );
        let connection = Connection::open(target.join(PROJECT_TREE_FILE)).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT id FROM recent_files ORDER BY last_used DESC LIMIT 1",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            9
        );
    }

    /// WAL だけに追記された変更も検知し、通常 DB の指紋は旧形式と一致する。
    #[test]
    fn database_fingerprint_includes_uncheckpointed_wal_updates() {
        let test_directory = TestDirectory::new();
        let database_path = test_directory.path().join(PROJECT_TREE_FILE);
        create_test_database(&database_path);
        assert_eq!(
            fingerprint_data_file(&database_path).unwrap(),
            fingerprint_file(&database_path).unwrap()
        );
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;")
            .unwrap();
        let before_main = fingerprint_file(&database_path).unwrap();
        let before_data = fingerprint_data_file(&database_path).unwrap();

        connection
            .execute("INSERT INTO documents(name) VALUES ('wal update')", [])
            .unwrap();

        assert_eq!(fingerprint_file(&database_path).unwrap(), before_main);
        assert_ne!(fingerprint_data_file(&database_path).unwrap(), before_data);
        assert!(verify_sqlite_cleanup_safe(test_directory.path()).is_err());
        drop(connection);
    }

    /// Git登録と保管先・記録者も既存DBの移行に含め、原稿リポジトリ自体は移動しない。
    #[test]
    fn migrates_git_workspaces_and_backup_locations() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source");
        let target = directory.path().join("target");
        crate::project_tree::prepare_new_database_file(&source.join(PROJECT_TREE_FILE)).unwrap();
        let connection = Connection::open(source.join(PROJECT_TREE_FILE)).unwrap();
        connection.execute("INSERT INTO git_workspaces(root, backup, author_name, author_email) VALUES ('C:/原稿', 'D:/backup.git', '作者', '')", []).unwrap();
        drop(connection);
        migrate_data_files(&source, &target).unwrap();
        assert!(sqlite_contents_match(
            &source.join(PROJECT_TREE_FILE),
            &target.join(PROJECT_TREE_FILE)
        )
        .unwrap());
        let connection = Connection::open(target.join(PROJECT_TREE_FILE)).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT backup FROM git_workspaces", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "D:/backup.git"
        );
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
}
