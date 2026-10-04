//! 実 Git と一時フォルダーだけを使い、履歴と失敗時の保護を検証する。
use super::{register, repository::*};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 原稿の変更だけを表示し、同名の別パス・削除・不正バイト列を安全に区別する。
#[test]
fn file_history_selects_current_path_and_deleted_state() {
    let temp = Sandbox::new();
    let root = temp.repo("作品 空白");
    fs::create_dir(root.join("章")).unwrap();
    fs::write(root.join("章/原稿 [1].TXT"), b"\xef\xbb\xbffirst\r\n").unwrap();
    fs::write(root.join("原稿 [1].TXT"), "other").unwrap();
    let first = record_all(&root);
    fs::write(root.join("原稿 [1].TXT"), "unrelated").unwrap();
    record_all(&root);
    fs::write(root.join("章/原稿 [1].TXT"), [255]).unwrap();
    let second = record_all(&root);
    fs::remove_file(root.join("章/原稿 [1].TXT")).unwrap();
    let deleted = record_all(&root);
    let before_index = fs::read(root.join(".git/index")).unwrap();
    let requested = if cfg!(windows) {
        "章/原稿 [1].txt"
    } else {
        "章/原稿 [1].TXT"
    };
    let page = file_history(&root, requested, 0, "").unwrap();
    assert_eq!(page.head, deleted);
    assert_eq!(page.entries.len(), 3);
    assert!(page.entries[0].path.is_none());
    assert_eq!(page.entries[1].entry.id, second);
    assert_eq!(page.entries[1].path.as_deref(), Some("章/原稿 [1].TXT"));
    assert_eq!(page.entries[2].entry.id, first);
    assert_eq!(blob(&root, &second, "章/原稿 [1].TXT").unwrap(), [255]);
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), before_index);
    assert!(!page.has_more);
    assert!(file_history(&root, requested, 0, &first).is_err());
    assert!(file_history(&root, "../outside.txt", 0, "").is_err());
    assert!(file_history(&root, ".git/config", 0, "").is_err());
    assert!(file_history(&root, "image.png", 0, "").is_err());
}

/// 記録なしと未登録パスは空の履歴を返し、名前変更前の履歴を追跡しない。
#[test]
fn file_history_does_not_follow_renames() {
    let temp = Sandbox::new();
    let root = temp.repo("原稿");
    assert!(file_history(&root, "new.txt", 0, "")
        .unwrap()
        .entries
        .is_empty());
    fs::write(root.join("old.txt"), "text").unwrap();
    record_all(&root);
    fs::rename(root.join("old.txt"), root.join("new.txt")).unwrap();
    let renamed = record_all(&root);
    let page = file_history(&root, "new.txt", 0, "").unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].entry.id, renamed);
    assert!(file_history(&root, "absent.txt", 0, "")
        .unwrap()
        .entries
        .is_empty());
}

/// 50件を超える履歴を同じ基準で送り、基準更新後のページを混ぜない。
#[test]
fn file_history_pages_use_a_verified_head() {
    let temp = Sandbox::new();
    let root = temp.repo("pages");
    for index in 0..52 {
        fs::write(root.join("draft.txt"), index.to_string()).unwrap();
        git(&root, &["add", "--", "draft.txt"]).unwrap();
        git(
            &root,
            &["commit", "--quiet", "-m", &format!("記録 {index}")],
        )
        .unwrap();
    }
    let first = file_history(&root, "draft.txt", 0, "").unwrap();
    assert_eq!(first.entries.len(), 50);
    assert!(first.has_more);
    let next = file_history(&root, "draft.txt", 50, &first.head).unwrap();
    assert_eq!(next.entries.len(), 2);
    assert!(!next.has_more);
    assert_eq!(next.entries[0].entry.message, "記録 1");
    fs::write(root.join("draft.txt"), "later").unwrap();
    record_all(&root);
    assert!(file_history(&root, "draft.txt", 50, &first.head).is_err());
}
struct Sandbox(PathBuf);
impl Sandbox {
    /// 並列テストから独立した作業フォルダーを用意する。
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "novel-git-test-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    /// 任意の初期設定に依存しない原稿用 Git を作る。
    fn repo(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir(&path).unwrap();
        initialize(&path).unwrap();
        git(&path, &["config", "user.name", "テスト作者"]).unwrap();
        git(&path, &["config", "user.email", "test@localhost"]).unwrap();
        git(&path, &["config", "core.autocrlf", "false"]).unwrap();
        path
    }
}
impl Drop for Sandbox {
    /// テストで所有する一時ルートだけを片付ける。
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
/// 確認した全 TXT の変更を一回分として記録する。
fn record_all(path: &std::path::Path) -> String {
    let s = status(path, None).unwrap();
    record(
        path,
        &s.token,
        &s.changes.iter().map(|c| c.path.clone()).collect::<Vec<_>>(),
        "推敲の記録",
        "",
        " ",
    )
    .unwrap()
}

/// 初回から追加・編集・削除まで、TXTだけを記録し、元バイト列を取り出す。
#[test]
fn records_only_selected_txt_and_preserves_bytes() {
    let temp = Sandbox::new();
    let root = temp.repo("作品 空白");
    fs::write(root.join("原稿.txt"), b"\xef\xbb\xbfhello\r\n").unwrap();
    fs::write(root.join("資料.md"), "outside").unwrap();
    fs::write(root.join(".gitignore"), "除外.txt\n").unwrap();
    fs::write(root.join("除外.txt"), "ignored").unwrap();
    let first = record_all(&root);
    assert_eq!(files(&root, &first).unwrap(), vec!["原稿.txt"]);
    assert_eq!(
        blob(&root, &first, "原稿.txt").unwrap(),
        b"\xef\xbb\xbfhello\r\n"
    );
    fs::write(root.join("原稿.txt"), b"\xff\xfe").unwrap();
    let second = record_all(&root);
    assert_eq!(blob(&root, &second, "原稿.txt").unwrap(), b"\xff\xfe");
    fs::remove_file(root.join("原稿.txt")).unwrap();
    record_all(&root);
    assert_eq!(history(&root, 0).unwrap().len(), 3);
    assert_eq!(history(&root, 2).unwrap().len(), 1);
    assert_eq!(history(&root, 50).unwrap().len(), 0);
    assert_eq!(fs::read_to_string(root.join("資料.md")).unwrap(), "outside");
}

/// ステージ・ロック・途中の処理・古い確認結果で記録せず、インデックスを維持する。
#[test]
fn refuses_staged_busy_and_stale_without_reset() {
    let temp = Sandbox::new();
    let root = temp.repo("draft");
    fs::write(root.join("a.txt"), "first").unwrap();
    record_all(&root);
    fs::write(root.join("a.txt"), "next").unwrap();
    let s = status(&root, None).unwrap();
    let before = fs::read(root.join(".git/index")).unwrap();
    fs::write(root.join("a.txt"), "later").unwrap();
    assert!(record(&root, &s.token, &["a.txt".into()], "test", "", "").is_err());
    assert_eq!(before, fs::read(root.join(".git/index")).unwrap());
    for marker in ["index.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD"] {
        fs::write(root.join(".git").join(marker), "").unwrap();
        assert!(status(&root, None).unwrap().blocked.is_some());
        fs::remove_file(root.join(".git").join(marker)).unwrap();
    }
    git(&root, &["add", "a.txt"]).unwrap();
    let s = status(&root, None).unwrap();
    assert!(s.blocked.is_some());
    let staged = fs::read(root.join(".git/index")).unwrap();
    assert!(record(&root, &s.token, &["a.txt".into()], "test", "", "").is_err());
    assert_eq!(staged, fs::read(root.join(".git/index")).unwrap());
}

/// 独立したbareへの送信・追加送信・復元を確認し、元保管先がなくても履歴を読める。
#[test]
fn backs_up_and_restores_independent_copy_without_force() {
    let temp = Sandbox::new();
    let root = temp.repo("draft");
    let target = temp.0.join("backup.git");
    fs::create_dir(&target).unwrap();
    prepare_backup(&root, &target).unwrap();
    fs::write(root.join("a.txt"), "one").unwrap();
    let first = record_all(&root);
    backup(&root, &target, &status(&root, None).unwrap().token).unwrap();
    assert_eq!(
        status(&root, Some(&target)).unwrap().backup_state,
        BackupState::Current
    );
    fs::write(root.join("a.txt"), "two").unwrap();
    record_all(&root);
    backup(&root, &target, &status(&root, None).unwrap().token).unwrap();
    let restored = restore(&target, &temp.0.join("restored"), "main").unwrap();
    assert_eq!(fs::read_to_string(restored.join("a.txt")).unwrap(), "two");
    assert!(restore(&target, &restored, "main").is_err());
    git(&root, &["update-ref", "refs/heads/main", &first]).unwrap();
    assert!(backup(&root, &target, &status(&root, None).unwrap().token).is_err());
    fs::rename(&target, temp.0.join("unplugged.git")).unwrap();
    assert_eq!(
        status(&root, Some(&target)).unwrap().backup_state,
        BackupState::Unknown
    );
    assert_eq!(history(&restored, 0).unwrap().len(), 2);
    assert!(!restored.join(".git/objects/info/alternates").exists());
}

/// 他形式や範囲外パス・入れ子・不正IDを Git に渡さない。
#[test]
fn rejects_paths_nested_repos_and_invalid_ids() {
    let temp = Sandbox::new();
    let root = temp.repo("draft");
    for path in ["../a.txt", "/a.txt", "a.md", ".git/config.txt"] {
        assert!(text_path(&root, path).is_err());
    }
    fs::create_dir(root.join("nested")).unwrap();
    initialize(&root.join("nested")).unwrap();
    // initialize は既存の親 Git を使うため、テストだけ明示的に入れ子を作る。
    git(&root.join("nested"), &["init"]).unwrap();
    fs::write(root.join("nested/a.txt"), "nested").unwrap();
    assert!(text_path(&root, "nested/a.txt").is_err());
    assert!(files(&root, "HEAD").is_err());
    assert!(prepare_backup(&root, &root).is_err());
}

/// 旧DBへ登録テーブルを補い、重複せず、登録だけでも移行先を空と判定しない。
#[test]
fn persists_registration_and_upgrades_old_database() {
    let temp = Sandbox::new();
    let db = temp.0.join("project-tree.sqlite3");
    super::super::database::prepare_new_database_file(&db).unwrap();
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection.execute("DROP TABLE git_workspaces", []).unwrap();
    drop(connection);
    super::super::database::validate_database_file(&db).unwrap();
    let connection = super::super::database::initialize_database(db.clone()).unwrap();
    register(&connection, &temp.0).unwrap();
    register(&connection, &temp.0).unwrap();
    drop(connection);
    assert!(!super::super::database::is_empty_database_file(&db).unwrap());
    let connection = rusqlite::Connection::open(db).unwrap();
    assert_eq!(super::workspaces(&connection).unwrap().len(), 1);
}

/// 参照のロックで確定に失敗しても、HEAD・通常インデックス・本文を元のまま保つ。
#[test]
fn failed_commit_preserves_index_and_does_not_remove_foreign_lock() {
    let temp = Sandbox::new();
    let root = temp.repo("draft");
    fs::write(root.join("a.txt"), "first").unwrap();
    let first = record_all(&root);
    fs::write(root.join("a.txt"), "next").unwrap();
    let before = fs::read(root.join(".git/index")).unwrap();
    let branch_lock = root.join(".git/refs/heads/main.lock");
    fs::write(&branch_lock, "foreign lock").unwrap();
    let s = status(&root, None).unwrap();
    assert!(record(&root, &s.token, &["a.txt".into()], "test", "", "").is_err());
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), before);
    assert_eq!(history(&root, 0).unwrap()[0].id, first);
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "next");
    assert_eq!(fs::read_to_string(&branch_lock).unwrap(), "foreign lock");
    assert!(!root.join(".git/index.lock").exists());
    assert!(!root
        .join(format!(".git/novel-editor-index-{}", std::process::id()))
        .exists());
    fs::remove_file(branch_lock).unwrap();
    record_all(&root);
}

/// 選択外のTXTを巻き込まず、Git属性による改行変換を履歴だけに適用する。
#[test]
fn honors_attributes_and_keeps_unselected_changes() {
    let temp = Sandbox::new();
    let root = temp.repo("draft");
    fs::write(root.join(".gitattributes"), "*.txt text eol=lf\n").unwrap();
    fs::write(root.join("a.txt"), b"a\r\n").unwrap();
    fs::write(root.join("b.TXT"), b"b\r\n").unwrap();
    let s = status(&root, None).unwrap();
    let id = record(&root, &s.token, &["a.txt".into()], "selected", "", "").unwrap();
    assert_eq!(blob(&root, &id, "a.txt").unwrap(), b"a\n");
    assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"a\r\n");
    assert_eq!(files(&root, &id).unwrap(), vec!["a.txt"]);
    assert!(status(&root, None)
        .unwrap()
        .changes
        .iter()
        .any(|c| c.path == "b.TXT"));
    git(&root, &["checkout", "--detach"]).unwrap();
    assert!(status(&root, None).unwrap().blocked.is_some());
}

/// 空の記録名を含む既存履歴も読み取り、失敗した保管先設定ではデータを壊さない。
#[test]
fn reads_existing_empty_messages_and_rejects_nonbare_backup() {
    let temp = Sandbox::new();
    let root = temp.repo("draft");
    fs::write(root.join("a.txt"), "test").unwrap();
    record_all(&root);
    git(
        &root,
        &[
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--allow-empty",
            "--allow-empty-message",
            "-m",
            "",
        ],
    )
    .unwrap();
    assert_eq!(history(&root, 0).unwrap()[0].message, "");
    let other = temp.repo("existing");
    fs::write(other.join("keep.txt"), "keep").unwrap();
    assert!(prepare_backup(&root, &other).is_err());
    assert_eq!(fs::read_to_string(other.join("keep.txt")).unwrap(), "keep");
    assert!(restore(&other, &temp.0.join("new"), "main").is_err());
}

/// 取り出し先の作成競合・書込先不正を検出し、既存内容と履歴の元バイトを保持する。
#[test]
fn export_is_exclusive_and_preserves_original_bytes() {
    let temp = Sandbox::new();
    let target = temp.0.join("取り出した原稿.txt");
    let bytes = b"\xef\xbb\xbffirst\r\nsecond\rthird\n\xff";
    super::write_new(&target, bytes).unwrap();
    assert_eq!(fs::read(&target).unwrap(), bytes);
    assert!(super::write_new(&target, b"overwritten").is_err());
    assert_eq!(fs::read(&target).unwrap(), bytes);
    assert!(super::write_new(&temp.0.join("missing/child.txt"), bytes).is_err());
    assert!(super::write_new(&temp.0, bytes).is_err());
}

/// 初回・一致・不一致・確認不能の判定と復元候補の説明を実Gitから取得する。
#[test]
fn returns_typed_states_and_restore_metadata() {
    let temp = Sandbox::new();
    let root = temp.repo("作品");
    assert_eq!(
        status(&root, None).unwrap().backup_state,
        BackupState::NotSet
    );
    assert!(history(&root, 0).unwrap().is_empty());
    let target = temp.0.join("backup");
    fs::create_dir(&target).unwrap();
    prepare_backup(&root, &target).unwrap();
    assert_eq!(
        status(&root, Some(&target)).unwrap().backup_state,
        BackupState::NoHistory
    );
    fs::write(root.join("章.txt"), "first").unwrap();
    let id = record_all(&root);
    assert_eq!(
        status(&root, Some(&target)).unwrap().backup_state,
        BackupState::Different
    );
    backup(&root, &target, &status(&root, None).unwrap().token).unwrap();
    let candidates = branches(&target).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].name, "main");
    assert_eq!(candidates[0].id, id);
    assert_eq!(candidates[0].message, "推敲の記録");
    assert!(!candidates[0].date.is_empty());
    assert_eq!(
        status(&root, Some(&target)).unwrap().backup_state,
        BackupState::Current
    );
    git(&root, &["update-ref", "refs/heads/別の案", &id]).unwrap();
    git(
        &root,
        &[
            "push",
            "--",
            &display(&target),
            "refs/heads/別の案:refs/heads/別の案",
        ],
    )
    .unwrap();
    assert_eq!(branches(&target).unwrap().len(), 2);
    git(&root, &["checkout", "--detach"]).unwrap();
    assert_eq!(
        status(&root, None).unwrap().blocked,
        Some(RecordBlock::Detached)
    );
}

/// 壊れた記録への参照を、まだ履歴がない状態として画面へ返さない。
#[test]
fn rejects_corrupt_history_instead_of_reporting_empty() {
    let temp = Sandbox::new();
    let root = temp.repo("draft");
    fs::write(root.join("a.txt"), "first").unwrap();
    record_all(&root);
    fs::write(
        root.join(".git/refs/heads/main"),
        format!("{}\n", "b".repeat(40)),
    )
    .unwrap();
    assert!(history(&root, 0).is_err());
    assert!(status(&root, None).is_err());
}

/// 部分成功の種別・出力先・元のエラーがTauri境界で失われないことを確認する。
#[test]
fn serializes_partial_results_without_claiming_no_output() {
    for kind in [
        super::FailureKind::RecordedNeedsAttention,
        super::FailureKind::OutputIncomplete,
        super::FailureKind::RestoredRegistrationFailed,
    ] {
        let failure = super::Failure::partial(kind, "詳しい理由".into(), "出力先".into());
        let value = serde_json::to_value(failure).unwrap();
        assert_ne!(value["kind"], "unknown");
        assert_eq!(value["details"], "詳しい理由");
        assert_eq!(value["output"], "出力先");
    }
    let failure: super::Failure = "未分類の理由".into();
    let value = serde_json::to_value(failure).unwrap();
    assert_eq!(value["kind"], "unknown");
    assert!(value["output"].is_null());
}

/// インデックスを他プロセス相当の共有条件で開き、記録後の確定失敗でも履歴と回復用ロックを残す。
#[cfg(windows)]
#[test]
fn reports_recorded_history_when_index_finalize_is_locked() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = Sandbox::new();
    let root = temp.repo("draft");
    fs::write(root.join("a.txt"), "first").unwrap();
    let old = record_all(&root);
    fs::write(root.join("a.txt"), "edited").unwrap();
    let snapshot = status(&root, None).unwrap();
    let index = root.join(".git/index");
    let index_bytes = fs::read(&index).unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .open(&index)
        .unwrap();
    let failure = record(
        &root,
        &snapshot.token,
        &["a.txt".into()],
        "後処理を検証",
        "",
        "",
    )
    .unwrap_err();
    assert!(matches!(
        failure.kind,
        super::FailureKind::RecordedNeedsAttention
    ));
    let head = status(&root, None).unwrap().head;
    assert_ne!(head, old);
    assert_eq!(failure.output.as_deref(), Some(head.as_str()));
    assert_eq!(fs::read(&index).unwrap(), index_bytes);
    assert!(root.join(".git/index.lock").exists());
    assert_eq!(blob(&root, &head, "a.txt").unwrap(), b"edited");
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "edited");
    drop(held);
}

/// 既存履歴にWindowsで取り出せない名前がある場合、作成途中の復元先を明示し、元データを残す。
#[cfg(windows)]
#[test]
fn reports_partial_destination_when_checkout_fails() {
    let temp = Sandbox::new();
    let root = temp.repo("draft");
    fs::write(root.join("a.txt"), "first").unwrap();
    let first = record_all(&root);
    let blob = String::from_utf8(git(&root, &["hash-object", "-w", "--stdin"]).unwrap()).unwrap();
    let cache = format!("100644,{},AUX.txt", blob.trim());
    git(
        &root,
        &[
            "-c",
            "core.protectNTFS=false",
            "update-index",
            "--add",
            "--cacheinfo",
            &cache,
        ],
    )
    .unwrap();
    let tree = String::from_utf8(git(&root, &["write-tree"]).unwrap()).unwrap();
    let id = String::from_utf8(
        git(
            &root,
            &["commit-tree", tree.trim(), "-p", &first, "-m", "別OSの原稿"],
        )
        .unwrap(),
    )
    .unwrap();
    let target = temp.0.join("backup");
    fs::create_dir(&target).unwrap();
    prepare_backup(&root, &target).unwrap();
    git(
        &root,
        &[
            "push",
            "--",
            &display(&target),
            &format!("{}:refs/heads/main", id.trim()),
        ],
    )
    .unwrap();
    let destination = temp.0.join("restored");
    let failure = restore(&target, &destination, "main").unwrap_err();
    assert!(matches!(failure.kind, super::FailureKind::OutputIncomplete));
    assert_eq!(
        failure.output.as_deref(),
        Some(display(&destination).as_str())
    );
    assert!(destination.is_dir());
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "first");
    assert_eq!(branches(&target).unwrap()[0].id, id.trim());
}
