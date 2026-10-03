//! 実 Git と一時フォルダーだけを使い、履歴と失敗時の保護を検証する。
use super::{register, repository::*};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
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
        "バックアップ済み"
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
        "バックアップ先を確認できません"
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
