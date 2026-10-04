//! 許可済みTXTの外部更新確認と、比較から書込まで同じハンドルを使う条件付き保存。
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
};
use tauri::Window;
use tauri_plugin_fs::FsExt;

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiskState {
    Present { bytes: Vec<u8> },
    Missing,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveResult {
    Saved,
    Conflict { disk: DiskState },
}

/// メイン窓の許可済み絶対TXTパスだけを受け付け、検査によって権限は増やさない。
fn validate_access(label: &str, path: &Path, allowed: bool) -> Result<(), String> {
    if label != "main" || !allowed || !path.is_absolute() {
        return Err("メイン画面で許可された絶対パスだけを操作できます".into());
    }
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("txt"))
    {
        return Err("TXTファイルだけを操作できます".into());
    }
    Ok(())
}

/// 通常ファイルの内容を開いたハンドルから取得し、ディレクトリ等を拒否する。
fn read_regular(file: &mut File) -> Result<Vec<u8>, String> {
    if !file
        .metadata()
        .map_err(|error| format!("ファイル情報を確認できません: {error}"))?
        .is_file()
    {
        return Err("参照先が通常ファイルではありません".into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("ファイルを読み込めません: {error}"))?;
    Ok(bytes)
}

/// 読取中の書換え・置換をWindowsの共有モードで拒否し、一貫した内容を取得する。
fn open_existing(path: &Path, writable: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(writable);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1); // FILE_SHARE_READのみ。書込・削除はハンドルを閉じるまで拒否する。
    }
    options.open(path)
}

/// 欠落を読取失敗と区別し、UTF-8の妥当性によらず比較用バイト列を返す。
fn inspect(path: &Path) -> Result<DiskState, String> {
    match open_existing(path, false) {
        Ok(mut file) => Ok(DiskState::Present {
            bytes: read_regular(&mut file)?,
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DiskState::Missing),
        Err(error) => Err(format!("ファイルを確認できません: {error}")),
    }
}

/// 期待値が一致した場合だけ保存する。既存ファイルは検査前に切り詰めず、新規は排他的に作る。
fn save_conditional(path: &Path, expected: DiskState, bytes: &[u8]) -> Result<SaveResult, String> {
    let mut file = match expected {
        DiskState::Present {
            bytes: expected_bytes,
        } => {
            let mut file = match open_existing(path, true) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    return Ok(SaveResult::Conflict {
                        disk: DiskState::Missing,
                    })
                }
                Err(error) => return Err(format!("保存用ファイルを開けません: {error}")),
            };
            let actual = read_regular(&mut file)?;
            if actual != expected_bytes {
                return Ok(SaveResult::Conflict {
                    disk: DiskState::Present { bytes: actual },
                });
            }
            file
        }
        DiskState::Missing => {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.share_mode(1);
            }
            match options.open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    return Ok(SaveResult::Conflict {
                        disk: inspect(path)?,
                    })
                }
                Err(error) => return Err(format!("ファイルを新規作成できません: {error}")),
            }
        }
    };
    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.write_all(bytes))
        .and_then(|_| file.set_len(bytes.len() as u64))
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            format!("書き込みに失敗しました。本文を別名で保存してください: {error}")
        })?;
    Ok(SaveResult::Saved)
}

/// UIを止めずにディスク状態を取得する。呼出元と許可範囲はI/O前に確認する。
#[tauri::command]
pub async fn text_file_inspect(window: Window, path: String) -> Result<DiskState, String> {
    validate_access(
        window.label(),
        Path::new(&path),
        window.fs_scope().is_allowed(&path),
    )?;
    tauri::async_runtime::spawn_blocking(move || inspect(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

/// 内容の期待値を伴う保存を実行する。強制保存でも確認時の期待値は必須とする。
#[tauri::command]
pub async fn text_file_save_conditional(
    window: Window,
    path: String,
    expected: DiskState,
    bytes: Vec<u8>,
) -> Result<SaveResult, String> {
    validate_access(
        window.label(),
        Path::new(&path),
        window.fs_scope().is_allowed(&path),
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        save_conditional(Path::new(&path), expected, &bytes)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestFile {
        directory: PathBuf,
        path: PathBuf,
    }
    impl TestFile {
        /// テスト専用の一時フォルダーに原稿を用意し、利用者のファイルから隔離する。
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "novel-external-test-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&directory).unwrap();
            Self {
                path: directory.join("原稿.txt"),
                directory,
            }
        }
    }
    impl Drop for TestFile {
        /// テストで作成した一時データだけを片付ける。
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    /// 新規作成・通常保存・短くなる保存と、BOMや不正UTF-8も比較対象になることを確認する。
    #[test]
    fn saves_only_when_bytes_match() {
        let file = TestFile::new();
        assert_eq!(inspect(&file.path).unwrap(), DiskState::Missing);
        let original = b"\xef\xbb\xbftext\r\nlong";
        assert_eq!(
            save_conditional(&file.path, DiskState::Missing, original).unwrap(),
            SaveResult::Saved
        );
        let before = inspect(&file.path).unwrap();
        assert_eq!(
            save_conditional(&file.path, before, b"a").unwrap(),
            SaveResult::Saved
        );
        assert_eq!(fs::read(&file.path).unwrap(), b"a");
        fs::write(&file.path, [0xff]).unwrap();
        assert_eq!(
            save_conditional(
                &file.path,
                DiskState::Present {
                    bytes: b"a".to_vec()
                },
                b"lost"
            )
            .unwrap(),
            SaveResult::Conflict {
                disk: DiskState::Present { bytes: vec![0xff] }
            }
        );
        assert_eq!(fs::read(&file.path).unwrap(), [0xff]);
    }

    /// 外部削除や作成の競合では再作成・上書きせず、確認した状態との差を返す。
    #[test]
    fn detects_creation_and_deletion_races() {
        let file = TestFile::new();
        assert_eq!(
            save_conditional(&file.path, DiskState::Present { bytes: vec![] }, b"new").unwrap(),
            SaveResult::Conflict {
                disk: DiskState::Missing
            }
        );
        assert!(!file.path.exists());
        fs::write(&file.path, b"external").unwrap();
        assert!(matches!(
            save_conditional(&file.path, DiskState::Missing, b"mine").unwrap(),
            SaveResult::Conflict { .. }
        ));
        assert_eq!(fs::read(&file.path).unwrap(), b"external");
    }

    /// 相対・未許可・子窓・非TXT・ディレクトリは読み書き対象にしない。
    #[test]
    fn rejects_unauthorized_paths_and_non_files() {
        let file = TestFile::new();
        assert!(validate_access("main", &file.path, true).is_ok());
        assert!(validate_access("search", &file.path, true).is_err());
        assert!(validate_access("main", &file.path, false).is_err());
        assert!(validate_access("main", Path::new("relative.txt"), true).is_err());
        assert!(validate_access("main", &file.path.with_extension("exe"), true).is_err());
        fs::create_dir(&file.path).unwrap();
        assert!(inspect(&file.path).is_err());
        assert!(save_conditional(&file.path, DiskState::Missing, b"mine").is_err());
    }

    /// 別プロセス側から共有モードと外部変更を確認する子テスト。通常の実行時は何もしない。
    #[cfg(windows)]
    #[test]
    fn child_file_action() {
        let Some(path) = std::env::var_os("NOVEL_EXTERNAL_TEST_PATH") else {
            return;
        };
        let path = Path::new(&path);
        match std::env::var("NOVEL_EXTERNAL_TEST_ACTION")
            .unwrap()
            .as_str()
        {
            "denied" => {
                assert!(fs::write(path, b"intruder").is_err());
                assert!(fs::remove_file(path).is_err());
                assert!(save_conditional(
                    path,
                    DiskState::Present {
                        bytes: b"original".to_vec()
                    },
                    b"intruder"
                )
                .is_err());
            }
            "update" => {
                fs::write(path, b"external").unwrap();
            }
            _ => panic!("unknown child test action"),
        }
    }

    /// Windows上で実際の別プロセスを起動し、検査用ハンドルが書込・削除・競合保存を拒否することを確かめる。
    #[cfg(windows)]
    #[test]
    fn windows_blocks_other_process_until_handle_closes() {
        let file = TestFile::new();
        fs::write(&file.path, b"original").unwrap();
        for writable in [false, true] {
            let handle = open_existing(&file.path, writable).unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "text_file::tests::child_file_action",
                    "--nocapture",
                ])
                .env("NOVEL_EXTERNAL_TEST_PATH", &file.path)
                .env("NOVEL_EXTERNAL_TEST_ACTION", "denied")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            assert_eq!(fs::read(&file.path).unwrap(), b"original");
            drop(handle);
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "text_file::tests::child_file_action",
                "--nocapture",
            ])
            .env("NOVEL_EXTERNAL_TEST_PATH", &file.path)
            .env("NOVEL_EXTERNAL_TEST_ACTION", "update")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(matches!(
            save_conditional(
                &file.path,
                DiskState::Present {
                    bytes: b"original".to_vec()
                },
                b"mine"
            )
            .unwrap(),
            SaveResult::Conflict { .. }
        ));
        assert_eq!(fs::read(&file.path).unwrap(), b"external");
    }
}
