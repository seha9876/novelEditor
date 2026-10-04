//! メイン窓からの型付き履歴操作と、Git 管理フォルダーの永続化を接続する。
mod repository;
#[cfg(test)]
mod tests;

use super::{database::lock_connection, ProjectTreeState};
use repository::{display, Status};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, Window};
use tauri_plugin_fs::FsExt;

static OPERATION: Mutex<()> = Mutex::new(());

/// 操作の途中まで完了した状態を、通常の失敗と混同せず画面へ伝える。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    Unknown,
    RecordedNeedsAttention,
    OutputIncomplete,
    RestoredRegistrationFailed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub kind: FailureKind,
    pub details: String,
    pub output: Option<String>,
}
impl Failure {
    /// 作成済みの記録や出力先を残し、再実行前に確認できる情報を渡す。
    fn partial(kind: FailureKind, details: String, output: String) -> Self {
        Self {
            kind,
            details,
            output: Some(output),
        }
    }
}
impl From<String> for Failure {
    /// 分類できない失敗の元情報を省略せず保持する。
    fn from(details: String) -> Self {
        Self {
            kind: FailureKind::Unknown,
            details,
            output: None,
        }
    }
}
impl From<&str> for Failure {
    /// 固定の検証エラーも同じ通信形式へ揃える。
    fn from(details: &str) -> Self {
        details.to_string().into()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: i64,
    root: String,
    backup: Option<String>,
    author_name: String,
    author_email: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    List,
    Inspect {
        path: String,
    },
    Register {
        path: String,
        expected_root: String,
    },
    Remove {
        id: i64,
    },
    Status {
        id: i64,
    },
    Record {
        id: i64,
        token: String,
        paths: Vec<String>,
        message: String,
        author_name: String,
        author_email: String,
    },
    History {
        id: i64,
        offset: u32,
    },
    FileHistory {
        id: i64,
        path: String,
        offset: u32,
        head: String,
    },
    Files {
        id: i64,
        commit: String,
    },
    Blob {
        id: i64,
        commit: String,
        path: String,
    },
    Export {
        id: i64,
        commit: String,
        path: String,
        destination: String,
    },
    SetBackup {
        id: i64,
        path: String,
    },
    Backup {
        id: i64,
        token: String,
    },
    Branches {
        path: String,
    },
    Restore {
        path: String,
        parent: String,
        name: String,
        branch: String,
    },
}

/// DB の Git 登録だけを取得し、本文や Git 自体の状態は保存しない。
fn workspaces(connection: &Connection) -> Result<Vec<Workspace>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, root, backup, author_name, author_email FROM git_workspaces ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let result = statement
        .query_map([], |r| {
            Ok(Workspace {
                id: r.get(0)?,
                root: r.get(1)?,
                backup: r.get(2)?,
                author_name: r.get(3)?,
                author_email: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

/// DB 接続の所有時間を SQL 操作だけに限定し、長い Git 処理と切り離す。
fn database<T>(
    window: &Window,
    action: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let state = window.state::<ProjectTreeState>();
    let guard = lock_connection(&state)?;
    action(guard.as_ref().ok_or("DB を利用できません")?)
}

/// クライアントの任意ルートを受け取らず、保存済み ID から操作対象を選ぶ。
fn workspace(window: &Window, id: i64) -> Result<Workspace, String> {
    let workspace = database(window, workspaces)?
        .into_iter()
        .find(|w| w.id == id)
        .ok_or("管理フォルダーが登録されていません")?;
    let resolved = fs::canonicalize(&workspace.root)
        .map_err(|e| format!("管理フォルダーを開けません: {e}"))?;
    if !display(&resolved).eq_ignore_ascii_case(&workspace.root)
        || repository::root(&resolved)? != resolved
    {
        return Err("管理フォルダーの参照先が変わりました。登録し直してください".into());
    }
    Ok(workspace)
}

/// ダイアログで許可された絶対フォルダーだけを実パスへ解決する。
fn selected_directory(window: &Window, path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute() || !window.fs_scope().is_allowed(path) {
        return Err("フォルダー選択から指定してください".into());
    }
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !path.is_dir() {
        return Err("フォルダーを選んでください".into());
    }
    Ok(path)
}

/// 既存 Git のルートまたは新規管理候補を返し、登録前に利用者へ実範囲を示す。
fn inspect(path: &Path) -> Result<PathBuf, String> {
    if path.ancestors().any(|p| p.join(".git").exists()) {
        repository::root(path)
    } else if path.join("HEAD").exists() && path.join("objects").exists() {
        Err("保管用リポジトリは管理フォルダーにできません".into())
    } else {
        Ok(path.to_path_buf())
    }
}

/// 同じルートの二重登録を避け、既存設定を変更せず登録する。
fn register(connection: &Connection, root: &Path) -> Result<(), String> {
    connection
        .execute(
            "INSERT OR IGNORE INTO git_workspaces(root) VALUES (?1)",
            [display(root)],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 履歴から取り出す TXT は排他的に新規作成し、既存の原稿には上書きしない。
fn export(window: &Window, destination: &str, bytes: &[u8]) -> Result<(), Failure> {
    let path = Path::new(destination);
    if !path.is_absolute()
        || !window.fs_scope().is_allowed(path)
        || !path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("txt"))
    {
        return Err("保存ダイアログで新しい TXT 名を選んでください".into());
    }
    let parent =
        fs::canonicalize(path.parent().ok_or("保存先が不正です")?).map_err(|e| e.to_string())?;
    let target = parent.join(path.file_name().ok_or("保存名が不正です")?);
    write_new(&target, bytes)
}

/// 取り出しの作成競合を排他的な作成で検出し、既存ファイルを開いて切り詰めない。
fn write_new(target: &Path, bytes: &[u8]) -> Result<(), Failure> {
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(|e| {
            format!("新規ファイルを作成できません。既存のファイルは上書きしません: {e}")
        })?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| {
            Failure::partial(FailureKind::OutputIncomplete,
                format!("取り出しに失敗しました。出力先に不完全なファイルが残っている可能性があります: {e}"), display(target))
        })
}

/// 管理フォルダーとバックアップの最新状態を一度に返す。
fn state(workspace: &Workspace) -> Result<Status, String> {
    let root = fs::canonicalize(&workspace.root).map_err(|e| e.to_string())?;
    repository::status(&root, workspace.backup.as_deref().map(Path::new))
}

/// 許可済みの操作だけを振り分ける。記録・送信・復元の終了まで直列化を保つ。
fn execute(window: &Window, request: Request) -> Result<Value, Failure> {
    match request {
        Request::List => {
            let version = repository::git(&std::env::temp_dir(), &["--version"]);
            Ok(
                json!({"workspaces":database(window,workspaces)?, "version":version.as_ref().ok().map(|v|String::from_utf8_lossy(v).trim().to_string()), "error":version.err()}),
            )
        }
        Request::Inspect { path } => Ok(json!(display(&inspect(&selected_directory(
            window, &path
        )?)?))),
        Request::Register {
            path,
            expected_root,
        } => {
            let selected = selected_directory(window, &path)?;
            let candidate = inspect(&selected)?;
            if display(&candidate) != expected_root {
                return Err("管理範囲が変更されました。選び直してください".into());
            }
            let root = repository::initialize(&candidate)?;
            database(window, |c| register(c, &root))?;
            Ok(json!(display(&root)))
        }
        Request::Remove { id } => {
            database(window, |c| {
                c.execute("DELETE FROM git_workspaces WHERE id=?1", [id])
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })?;
            Ok(Value::Null)
        }
        Request::Status { id } => Ok(json!(state(&workspace(window, id)?)?)),
        Request::Record {
            id,
            token,
            paths,
            message,
            author_name,
            author_email,
        } => {
            let w = workspace(window, id)?;
            let root = fs::canonicalize(&w.root).map_err(|e| e.to_string())?;
            if message.trim().is_empty() {
                return Err("記録名を指定してください".into());
            }
            // 記録の成否と設定保存の成否を混同しないよう、記録者設定を先に保存する。
            database(window, |c| {
                c.execute(
                    "UPDATE git_workspaces SET author_name=?1, author_email=?2 WHERE id=?3",
                    params![author_name, author_email, id],
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            })?;
            Ok(json!(repository::record(
                &root,
                &token,
                &paths,
                &message,
                &author_name,
                &author_email
            )?))
        }
        Request::History { id, offset } => Ok(json!(repository::history(
            Path::new(&workspace(window, id)?.root),
            offset
        )?)),
        Request::FileHistory {
            id,
            path,
            offset,
            head,
        } => Ok(json!(repository::file_history(
            Path::new(&workspace(window, id)?.root),
            &path,
            offset,
            &head
        )?)),
        Request::Files { id, commit } => Ok(json!(repository::files(
            Path::new(&workspace(window, id)?.root),
            &commit
        )?)),
        Request::Blob { id, commit, path } => Ok(json!(repository::blob(
            Path::new(&workspace(window, id)?.root),
            &commit,
            &path
        )?)),
        Request::Export {
            id,
            commit,
            path,
            destination,
        } => {
            export(
                window,
                &destination,
                &repository::blob(Path::new(&workspace(window, id)?.root), &commit, &path)?,
            )?;
            Ok(Value::Null)
        }
        Request::SetBackup { id, path } => {
            let w = workspace(window, id)?;
            let target = selected_directory(window, &path)?;
            repository::prepare_backup(
                &fs::canonicalize(&w.root).map_err(|e| e.to_string())?,
                &target,
            )?;
            database(window, |c| {
                c.execute(
                    "UPDATE git_workspaces SET backup=?1 WHERE id=?2",
                    params![display(&target), id],
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            })?;
            Ok(Value::Null)
        }
        Request::Backup { id, token } => {
            let w = workspace(window, id)?;
            let target = fs::canonicalize(w.backup.ok_or("バックアップ先を設定してください")?)
                .map_err(|e| e.to_string())?;
            repository::backup(
                &fs::canonicalize(&w.root).map_err(|e| e.to_string())?,
                &target,
                &token,
            )?;
            Ok(Value::Null)
        }
        Request::Branches { path } => Ok(json!(repository::branches(&selected_directory(
            window, &path
        )?)?)),
        Request::Restore {
            path,
            parent,
            name,
            branch,
        } => {
            let source = selected_directory(window, &path)?;
            let parent = selected_directory(window, &parent)?;
            if name.is_empty() || name.contains(['/', '\\', ':']) || name == "." || name == ".." {
                return Err("新しいフォルダー名を入力してください".into());
            }
            let restored = repository::restore(&source, &parent.join(name), &branch)?;
            database(window, |c| register(c, &restored)).map_err(|e| {
                Failure::partial(
                    FailureKind::RestoredRegistrationFailed,
                    format!("復元は完了しましたが一覧への登録に失敗しました: {e}"),
                    display(&restored),
                )
            })?;
            Ok(json!(display(&restored)))
        }
    }
}

/// 非同期のメイン窓専用入口。ブロッキング Git 実行を UI スレッドから分離する。
#[tauri::command]
pub async fn git_history(window: Window, request: Request) -> Result<Value, Failure> {
    if window.label() != "main" {
        return Err("履歴はメイン画面から操作してください".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATION
            .try_lock()
            .map_err(|_| "Git の処理中です。完了を待ってください".to_string())?;
        execute(&window, request)
    })
    .await
    .map_err(|e| Failure::from(e.to_string()))?
}
