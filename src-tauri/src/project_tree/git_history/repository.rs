//! Git の処理を引数配列で実行する。原稿の作業ツリーは記録時にも書き換えない。
use super::{Failure, FailureKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Change {
    pub path: String,
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub branch: String,
    pub head: String,
    pub changes: Vec<Change>,
    pub token: String,
    pub blocked: Option<RecordBlock>,
    pub author_name: String,
    pub author_email: String,
    pub backup_state: BackupState,
}
#[derive(Debug, Serialize)]
pub struct Entry {
    pub id: String,
    pub date: String,
    pub author: String,
    pub message: String,
}

/// 表示文言ではなく判定結果を渡し、確認不能を未送信と混同させない。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum BackupState {
    NotSet,
    NoHistory,
    Current,
    Different,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RecordBlock {
    Detached,
    Busy,
    StagedOrConflict,
}
impl RecordBlock {
    /// 記録を止める理由と、既存のGit状態を保つための対処を説明する。
    fn message(&self) -> &'static str {
        match self {
            Self::Detached => "記録先が選択されていません。既存のGitツールでブランチへ戻してから再確認してください",
            Self::Busy => "別の履歴処理が進行中です。完了してから再確認してください",
            Self::StagedOrConflict => "別のツールで記録を準備中、または変更が競合しています。既存のGitツールで処理を完了してから再確認してください",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct BackupBranch {
    pub name: String,
    pub id: String,
    pub date: String,
    pub message: String,
}

/// 初回記録前だけ空のHEADを認め、それ以外の読込失敗を空履歴として扱わない。
fn current_head(root: &Path) -> Result<String, String> {
    let output = command(root, None)?
        .args(["rev-parse", "--verify", "HEAD"])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return String::from_utf8(output.stdout)
            .map(|s| s.trim().to_string())
            .map_err(|e| e.to_string());
    }
    if let Ok(reference) = line(root, &["symbolic-ref", "--quiet", "HEAD"]) {
        let check = command(root, None)?
            .args(["show-ref", "--verify", "--quiet", &reference])
            .output()
            .map_err(|e| e.to_string())?;
        if check.status.code() == Some(1) {
            return Ok(String::new());
        }
    }
    checked(output).map(|_| String::new())
}

/// Windows の表示用パスから拡張長接頭辞を除き、Git にも同じ絶対パスを渡す。
pub fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(value) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{value}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
    }
}

/// 環境の Git 指定を除去し、シェルや対話を使わず、窓を出さずに実行する。
fn command(root: &Path, index: Option<&Path>) -> Result<Command, String> {
    command_with_pathspec(root, index, true)
}

/// 検証済みの読み取りにだけパス指定の拡張を許し、記録操作は常にリテラルに限定する。
fn command_with_pathspec(
    root: &Path,
    index: Option<&Path>,
    literal: bool,
) -> Result<Command, String> {
    // 管理フォルダー内の同名exeを起動しないよう、PATHの絶対ディレクトリから解決する。
    let executable_name = if cfg!(windows) { "git.exe" } else { "git" };
    let executable = std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .filter(|p| p.is_absolute())
                .map(|p| p.join(executable_name))
                .find(|p| p.is_file())
        })
        .ok_or(
            "Git を起動できません。Git for Windows をインストールしてアプリを再起動してください",
        )?;
    let mut command = Command::new(executable);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .current_dir(root)
        .args([
            "--no-pager",
            if literal {
                "--literal-pathspecs"
            } else {
                "--no-literal-pathspecs"
            },
            "-c",
            "core.quotepath=false",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.file.allow=always",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command)
}

/// Git の終了コードと標準エラーを確認し、日本語の操作エラーへ変換する。
fn checked(output: Output) -> Result<Vec<u8>, String> {
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(format!(
            "Git の処理を完了できません: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// 固定した Git 操作を実行し、バイト列を文字変換せず受け取る。
pub fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    checked(command(root, None)?.args(args).output().map_err(|e| {
        format!("Git を起動できません。Git for Windows をインストールしてください: {e}")
    })?)
}

/// Git の一行出力を UTF-8 として読む。パスの不正な文字列は置換せず拒否する。
fn line(root: &Path, args: &[&str]) -> Result<String, String> {
    String::from_utf8(git(root, args)?)
        .map(|s| s.trim_end_matches(['\r', '\n']).to_string())
        .map_err(|_| "Git の出力が UTF-8 ではありません".into())
}

/// フォルダーを実パスで解決し、通常の作業ツリーのルートを取得する。
pub fn root(path: &Path) -> Result<PathBuf, String> {
    let value = line(path, &["rev-parse", "--show-toplevel"])?;
    fs::canonicalize(value).map_err(|e| e.to_string())
}

/// フォルダー内に新規 Git を作る。既存 Git の検出失敗を新規管理と取り違えない。
pub fn initialize(path: &Path) -> Result<PathBuf, String> {
    for parent in path.ancestors() {
        if parent.join(".git").exists() {
            return root(path);
        }
    }
    git(path, &["init", "--initial-branch=main"])?;
    root(path)
}

/// 通常の相対 TXT パスだけを許可し、リンクや入れ子の Git をたどらない。
pub fn text_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
        || !path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("txt"))
    {
        return Err("管理フォルダー内の通常の TXT を指定してください".into());
    }
    let mut full = root.to_path_buf();
    for component in path.components() {
        full.push(component);
        if full
            .file_name()
            .is_some_and(|s| s.eq_ignore_ascii_case(".git"))
        {
            return Err("Git 内部は対象外です".into());
        }
        if let Ok(meta) = fs::symlink_metadata(&full) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("リンク先は記録対象外です".into());
                }
            }
            if meta.file_type().is_symlink() {
                return Err("リンク先は記録対象外です".into());
            }
            if meta.is_dir() && full.join(".git").exists() {
                return Err("入れ子の Git は対象外です".into());
            }
        }
    }
    if full.exists() && !full.is_file() {
        return Err("通常ファイルではありません".into());
    }
    Ok(full)
}

/// NUL 区切りの出力を読み、日本語・空白・改行を含むファイル名を保つ。
fn nul_strings(bytes: &[u8]) -> Result<Vec<String>, String> {
    bytes
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8(s.to_vec()).map_err(|_| "UTF-8 で表せないパスがあります".into()))
        .collect()
}

/// Git が使う管理ファイルの絶対位置を取得する。worktree の共有管理領域も尊重する。
fn git_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(line(
        root,
        &["rev-parse", "--path-format=absolute", "--git-path", name],
    )?))
}

/// 状態と内容の指紋を取得する。更新日時だけに依存せず、確認後の編集も検出する。
pub fn status(root: &Path, backup: Option<&Path>) -> Result<Status, String> {
    if self::root(root)? != root {
        return Err("登録した管理ルートが変わっています。登録し直してください".into());
    }
    let branch = line(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).unwrap_or_default();
    let head = current_head(root)?;
    let raw = git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ],
    )?;
    let mut hash = Sha256::new();
    hash.update(&raw);
    hash.update(&head);
    hash.update(&branch);
    hash.update(fs::read(git_path(root, "index")?).unwrap_or_default());
    let mut blocked = if branch.is_empty() {
        Some(RecordBlock::Detached)
    } else {
        None
    };
    for name in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
        "BISECT_LOG",
        "index.lock",
    ] {
        if git_path(root, name)?.exists() {
            blocked = Some(RecordBlock::Busy);
        }
    }
    let mut changes = Vec::new();
    for row in nul_strings(&raw)? {
        let bytes = row.as_bytes();
        if bytes.len() < 4 {
            return Err("Git の状態出力を解釈できません".into());
        }
        if bytes[0] != b' ' && bytes[0] != b'?' {
            blocked = Some(RecordBlock::StagedOrConflict);
        }
        let relative = &row[3..];
        if let Ok(path) = text_path(root, relative) {
            let kind = if bytes[0] == b'?' {
                "added"
            } else if bytes[1] == b'D' {
                "deleted"
            } else {
                "modified"
            };
            if kind != "deleted" {
                let content =
                    fs::read(path).map_err(|e| format!("{relative} を読めません: {e}"))?;
                hash.update((content.len() as u64).to_le_bytes());
                hash.update(content);
            }
            changes.push(Change {
                path: relative.into(),
                kind: kind.into(),
            });
        }
    }
    let author_name = line(root, &["config", "--get", "user.name"]).unwrap_or_default();
    let author_email = line(root, &["config", "--get", "user.email"]).unwrap_or_default();
    let backup_state = match backup {
        None => BackupState::NotSet,
        Some(path) => match remote_head(root, path, &branch) {
            Ok(remote) if !head.is_empty() && remote == head => BackupState::Current,
            Ok(_) if head.is_empty() => BackupState::NoHistory,
            Ok(_) => BackupState::Different,
            Err(_) => BackupState::Unknown,
        },
    };
    Ok(Status {
        branch,
        head,
        changes,
        token: format!("{:x}", hash.finalize()),
        blocked,
        author_name,
        author_email,
        backup_state,
    })
}

/// 一時インデックスとロックを所有し、この操作が作成したファイルだけを片付ける。
struct IndexGuard {
    lock: PathBuf,
    temporary: PathBuf,
    preserve_lock: bool,
}
impl Drop for IndexGuard {
    /// 自分の一時ファイルだけを削除し、確定後の回復用ロックは必要に応じて残す。
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.temporary);
        let _ = fs::remove_file(self.temporary.with_extension("lock"));
        if !self.preserve_lock {
            let _ = fs::remove_file(&self.lock);
        }
    }
}

/// 確認済み TXT だけでコミットを組み立て、HEAD の比較更新後にインデックスを確定する。
/// 通常のステージを直接変更しないので、失敗時に他の変更をリセットする必要がない。
pub fn record(
    root: &Path,
    token: &str,
    paths: &[String],
    message: &str,
    name: &str,
    email: &str,
) -> Result<String, Failure> {
    let before = status(root, None)?;
    if let Some(reason) = before.blocked {
        return Err(reason.message().into());
    }
    if before.token != token {
        return Err("確認後に変更がありました。一覧を更新して選び直してください".into());
    }
    if paths.is_empty()
        || paths
            .iter()
            .any(|p| !before.changes.iter().any(|c| &c.path == p))
    {
        return Err("記録対象を選択してください".into());
    }
    let author = if before.author_name.is_empty() {
        name.trim()
    } else {
        &before.author_name
    };
    let email = if before.author_email.is_empty() {
        if email.trim().is_empty() {
            "writer@localhost"
        } else {
            email.trim()
        }
    } else {
        &before.author_email
    };
    if author.is_empty()
        || [author, email]
            .iter()
            .any(|s| s.contains(['\n', '\r', '<', '>']))
    {
        return Err("記録者の名前・メールを確認してください".into());
    }
    let index = git_path(root, "index")?;
    let lock = index.with_file_name("index.lock");
    let mut locked = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .map_err(|e| format!("Git が使用中です: {e}"))?;
    let temporary = index.with_file_name(format!("novel-editor-index-{}", std::process::id()));
    if temporary.exists() {
        drop(locked);
        let _ = fs::remove_file(&lock);
        return Err("前回の一時インデックスが残っています。Git の状態を確認してください".into());
    }
    let mut guard = IndexGuard {
        lock,
        temporary,
        preserve_lock: false,
    };
    // ロック取得後にも同じ状態を確認する。自分の index.lock だけは判定から除外する。
    let second = status(root, None)?;
    if second.token != token {
        return Err("記録開始前に変更がありました。一覧を更新してください".into());
    }
    if index.exists() {
        fs::copy(&index, &guard.temporary).map_err(|e| e.to_string())?;
    } else {
        checked(
            command(root, Some(&guard.temporary))?
                .args(["read-tree", "--empty"])
                .output()
                .map_err(|e| e.to_string())?,
        )?;
    }
    let mut add = command(root, Some(&guard.temporary))?;
    add.args(["add", "-A", "--"]).args(paths);
    checked(add.output().map_err(|e| e.to_string())?)?;
    if status(root, None)?.token != token {
        return Err("記録中に原稿が変更されました。一覧を更新してください".into());
    }
    let tree = String::from_utf8(checked(
        command(root, Some(&guard.temporary))?
            .arg("write-tree")
            .output()
            .map_err(|e| e.to_string())?,
    )?)
    .map_err(|e| e.to_string())?;
    if !before.head.is_empty() && line(root, &["rev-parse", "HEAD^{tree}"])? == tree.trim() {
        return Err("記録する内容の変更がありません".into());
    }
    let mut commit = command(root, Some(&guard.temporary))?;
    commit.args(["commit-tree", tree.trim()]);
    if !before.head.is_empty() {
        commit.args(["-p", &before.head]);
    }
    commit
        .env("GIT_AUTHOR_NAME", author)
        .env("GIT_AUTHOR_EMAIL", email)
        .env("GIT_COMMITTER_NAME", author)
        .env("GIT_COMMITTER_EMAIL", email)
        .stdin(Stdio::piped());
    let mut child = commit.spawn().map_err(|e| e.to_string())?;
    let write_result = child
        .stdin
        .take()
        .ok_or("記録の入力を開始できません")?
        .write_all(message.as_bytes());
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    write_result.map_err(|e| e.to_string())?;
    let id = String::from_utf8(checked(output)?)
        .map_err(|e| e.to_string())?
        .trim()
        .to_string();
    locked
        .write_all(&fs::read(&guard.temporary).map_err(|e| e.to_string())?)
        .and_then(|_| locked.sync_all())
        .map_err(|e| e.to_string())?;
    drop(locked);
    if line(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])? != before.branch {
        return Err("ブランチが変更されました。記録を中止しました".into());
    }
    let old = if before.head.is_empty() {
        "0".repeat(id.len())
    } else {
        before.head
    };
    git(
        root,
        &[
            "update-ref",
            "-m",
            "novelEditor: 履歴を記録",
            &format!("refs/heads/{}", before.branch),
            &id,
            &old,
        ],
    )?;
    guard.preserve_lock = true;
    fs::rename(&guard.lock, &index).map_err(|e| {
        Failure::partial(
            FailureKind::RecordedNeedsAttention,
            format!(
                "履歴 {id} は記録済みですが後処理に失敗しました。index.lock を保持しました: {e}"
            ),
            id.clone(),
        )
    })?;
    guard.preserve_lock = false;
    Ok(id)
}

/// 完全なコミット ID だけを認め、リビジョン式をユーザー入力として実行しない。
fn validate_id(root: &Path, id: &str) -> Result<(), String> {
    if ![40, 64].contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("記録 ID が不正です".into());
    }
    if line(root, &["cat-file", "-t", id])? != "commit" {
        return Err("記録ではありません".into());
    }
    git(root, &["merge-base", "--is-ancestor", id, "HEAD"])?;
    Ok(())
}

/// 現在のブランチから到達可能な履歴を50件ずつ返す。
pub fn history(root: &Path, offset: u32) -> Result<Vec<Entry>, String> {
    if current_head(root)?.is_empty() {
        return Ok(vec![]);
    }
    let bytes = git(
        root,
        &[
            "log",
            "-z",
            "--max-count=50",
            &format!("--skip={offset}"),
            "--format=%H%x00%aI%x00%an%x00%s",
            "HEAD",
            "--",
        ],
    )?;
    parse_entries(bytes)
}

/// 共通の履歴形式を解釈し、破損した結果を空履歴に変えない。
fn parse_entries(bytes: Vec<u8>) -> Result<Vec<Entry>, String> {
    let text = String::from_utf8(bytes).map_err(|_| "履歴の文字コードを解釈できません")?;
    let rows: Vec<&str> = text
        .strip_suffix('\0')
        .unwrap_or(&text)
        .split('\0')
        .collect();
    if text.is_empty() {
        return Ok(vec![]);
    }
    if rows.len() % 4 != 0 {
        return Err("履歴を解釈できません".into());
    }
    Ok(rows
        .chunks(4)
        .map(|r| Entry {
            id: r[0].into(),
            date: r[1].into(),
            author: r[2].into(),
            message: r[3].into(),
        })
        .collect())
}

/// 過去の通常 TXT の一覧をモードも検査して返す。リンクや submodule は除外する。
pub fn files(root: &Path, id: &str) -> Result<Vec<String>, String> {
    validate_id(root, id)?;
    let mut files = Vec::new();
    for row in nul_strings(&git(root, &["ls-tree", "-r", "-z", id])?)? {
        if let Some((meta, path)) = row.split_once('\t') {
            if (meta.starts_with("100644 blob ") || meta.starts_with("100755 blob "))
                && text_path(root, path).is_ok()
            {
                files.push(path.into());
            }
        }
    }
    Ok(files)
}

/// 履歴の通常 TXT を Git に記録されたバイト列のまま取り出す。
pub fn blob(root: &Path, id: &str, path: &str) -> Result<Vec<u8>, String> {
    if !files(root, id)?.iter().any(|p| p == path) {
        return Err("この記録に TXT がありません".into());
    }
    git(root, &["cat-file", "blob", &format!("{id}:{path}")])
}

/// 管理ルートと保管先が同じ・包含関係にある指定を拒否する。
pub fn separate(root: &Path, target: &Path) -> Result<(), String> {
    if root.starts_with(target) || target.starts_with(root) {
        Err("管理フォルダーとバックアップ先は互いに外側を指定してください".into())
    } else {
        Ok(())
    }
}

/// 既存の通常フォルダーを壊さず、空の保管先だけを bare として初期化する。
pub fn prepare_backup(root: &Path, target: &Path) -> Result<(), String> {
    separate(root, target)?;
    if fs::read_dir(target)
        .map_err(|e| e.to_string())?
        .next()
        .is_none()
    {
        git(target, &["init", "--bare"])?;
    }
    validate_bare(target)
}

/// bare の実ルートだけを認め、親リポジトリへの誤送信を防ぐ。
pub fn validate_bare(path: &Path) -> Result<(), String> {
    if line(path, &["rev-parse", "--is-bare-repository"])? != "true"
        || fs::canonicalize(line(path, &["rev-parse", "--absolute-git-dir"])?)
            .map_err(|e| e.to_string())?
            != fs::canonicalize(path).map_err(|e| e.to_string())?
    {
        return Err("保管用の bare リポジトリを選んでください".into());
    }
    Ok(())
}

/// バックアップ先の同名ブランチだけを調べ、未接続を未送信と混同しない。
fn remote_head(root: &Path, target: &Path, branch: &str) -> Result<String, String> {
    validate_bare(target)?;
    let output = line(
        root,
        &[
            "ls-remote",
            "--heads",
            "--",
            &display(target),
            &format!("refs/heads/{branch}"),
        ],
    )?;
    Ok(output.split_whitespace().next().unwrap_or("").into())
}

/// 明示したブランチだけを非強制送信し、送信後の参照が期待値か検査する。
pub fn backup(root: &Path, target: &Path, token: &str) -> Result<(), String> {
    separate(root, target)?;
    validate_bare(target)?;
    let state = status(root, None)?;
    if state.token != token || state.branch.is_empty() || state.head.is_empty() {
        return Err("状態が変わりました。一覧を更新してください".into());
    }
    git(
        root,
        &[
            "-c",
            "push.followTags=false",
            "push",
            "--no-verify",
            "--no-follow-tags",
            "--",
            &display(target),
            &format!("{}:refs/heads/{}", state.head, state.branch),
        ],
    )?;
    if remote_head(root, target, &state.branch)? != state.head {
        return Err("送信後の記録 ID を確認できません。更新して確認してください".into());
    }
    Ok(())
}

/// 実在するブランチと最新記録を返し、専門用語を知らなくても復元候補を区別できるようにする。
pub fn branches(target: &Path) -> Result<Vec<BackupBranch>, String> {
    validate_bare(target)?;
    let output = line(
        target,
        &[
            "for-each-ref",
            "--format=%(refname:strip=2)%00%(objectname)%00%(authordate:iso-strict)%00%(subject)",
            "refs/heads/",
        ],
    )?;
    output
        .lines()
        .map(|row| {
            let fields: Vec<_> = row.split('\0').collect();
            if fields.len() != 4 {
                return Err("復元候補を解釈できません".into());
            }
            Ok(BackupBranch {
                name: fields[0].into(),
                id: fields[1].into(),
                date: fields[2].into(),
                message: fields[3].into(),
            })
        })
        .collect()
}

/// バックアップから新規フォルダーに独立複製する。失敗時も既存データは削除しない。
pub fn restore(source: &Path, destination: &Path, branch: &str) -> Result<PathBuf, Failure> {
    if !branches(source)?.iter().any(|s| s.name == branch) {
        return Err("復元するブランチを選んでください".into());
    }
    if destination.exists() {
        return Err("復元先には存在しない新しいフォルダー名を指定してください".into());
    }
    separate(source, destination)?;
    let parent = destination.parent().ok_or("復元先が不正です")?;
    fs::create_dir(destination).map_err(|e| e.to_string())?;
    git(
        parent,
        &[
            "-c",
            "core.hooksPath=",
            "clone",
            "--no-local",
            "--single-branch",
            "--no-tags",
            "--branch",
            branch,
            "--",
            &display(source),
            &display(destination),
        ],
    )
    .map_err(|e| Failure::partial(FailureKind::OutputIncomplete, e, display(destination)))?;
    root(destination)
        .map_err(|e| Failure::partial(FailureKind::OutputIncomplete, e, display(destination)))
}

/// 一件の原稿の過去状態。削除された時点は本文のない記録として区別する。
#[derive(Debug, Serialize)]
pub struct FileEntry {
    #[serde(flatten)]
    pub entry: Entry,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryPage {
    pub head: String,
    pub branch: String,
    pub entries: Vec<FileEntry>,
    pub has_more: bool,
}

/// 現在のパスに変更があった記録だけを返す。改名の追跡や書込は行わない。
pub fn file_history(
    root: &Path,
    relative: &str,
    offset: u32,
    expected_head: &str,
) -> Result<FileHistoryPage, String> {
    text_path(root, relative)?;
    let head = current_head(root)?;
    if !expected_head.is_empty() && head != expected_head {
        return Err("履歴の基準が変わりました。再確認してください".into());
    }
    let branch = line(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).unwrap_or_default();
    if head.is_empty() {
        return Ok(FileHistoryPage {
            head,
            branch,
            entries: vec![],
            has_more: false,
        });
    }
    validate_id(root, &head)?;
    let spec = format!(
        "{}{}",
        if cfg!(windows) {
            ":(literal,icase)"
        } else {
            ":(literal)"
        },
        relative
    );
    let bytes = checked(
        command_with_pathspec(root, None, false)?
            .args([
                "log",
                "-z",
                "--full-history",
                "--no-renames",
                "--max-count=51",
                &format!("--skip={offset}"),
                "--format=%H%x00%aI%x00%an%x00%s",
                &head,
                "--",
                &spec,
            ])
            .output()
            .map_err(|e| e.to_string())?,
    )?;
    let mut records = parse_entries(bytes)?;
    let has_more = records.len() > 50;
    records.truncate(50);
    let mut entries = Vec::new();
    for entry in records {
        let rows = nul_strings(&git(root, &["ls-tree", "-r", "-z", &entry.id])?)?;
        let mut paths = Vec::new();
        for row in rows {
            if let Some((meta, path)) = row.split_once('\t') {
                let matches = if cfg!(windows) {
                    path.to_lowercase() == relative.to_lowercase()
                } else {
                    path == relative
                };
                if matches && (meta.starts_with("100644 blob ") || meta.starts_with("100755 blob "))
                {
                    text_path(root, path)?;
                    paths.push(path.to_string());
                }
            }
        }
        if paths.len() > 1 {
            return Err(
                "大文字小文字だけが異なる原稿を区別できません。管理画面で確認してください".into(),
            );
        }
        entries.push(FileEntry {
            entry,
            path: paths.pop(),
        });
    }
    if current_head(root)? != head {
        return Err("履歴の確認中に記録が変わりました。再確認してください".into());
    }
    Ok(FileHistoryPage {
        head,
        branch,
        entries,
        has_more,
    })
}
