# 小説エディタ

小説の本文を TXT で書くための、Tauri 2 製 Windows デスクトップアプリです。

## 開発

Windows に Node.js、pnpm 10.6.3、Rust の MSVC ツールチェーン、WebView2 を用意してください。

初回のみ依存関係をインストールします。

```powershell
pnpm install
```

開発用アプリを起動します。Vue、TypeScript、CSS の変更は自動で反映され、`src-tauri` の変更時は Tauri が再コンパイルされます。

```powershell
pnpm tauri dev
```

## 確認とビルド

コードを変更したら、次のコマンドで TypeScript の型検査と lint をまとめて実行します。型検査に失敗した場合は lint を実行せず終了します。

```powershell
pnpm check
```

配布用の Windows 実行ファイルとインストーラを生成するには、次を実行します。ビルド前に TypeScript の型検査も実行されます。

```powershell
pnpm tauri build
```

配布用の実行ファイルと NSIS インストーラは `src-tauri/target/release/` に生成されます。

## 第三者ライセンス通知と配布

Rust の通知生成には `cargo-about` 0.9.2 を使います。初回のみ次を実行してください。

```powershell
cargo install --locked --version 0.9.2 --features cli cargo-about
```

依存関係を変更したときと Windows 版を配布する前に、次の順序で確認します。

```powershell
pnpm install --frozen-lockfile
pnpm notices
pnpm check
pnpm tauri build
```

`pnpm notices` は JavaScript の本番依存関係と Windows 向け Rust 依存関係から通知を再生成します。生成結果の [JavaScript 通知](THIRD_PARTY_NOTICES_JS.md) と [Rust 通知](src-tauri/THIRD_PARTY_NOTICES_RUST.html) は Git で管理し、依存関係を更新した際は差分を確認してください。通知生成時に本文が見つからない、または Rust に未許可のライセンスが加わった場合は生成が失敗します。

配布物には本アプリの `LICENSE` と両方の第三者通知が `licenses/` に同梱されます。インストーラを作成したら同梱を確認してください。Rust 通知内の `source code` リンクから各クレートの該当バージョンのソースを取得できます。MPL-2.0 のクレートについては、ソースの入手方法を含む条件を配布前に個別確認してください。通知の自動生成だけで全条件への適合を保証するものではありません。

## 操作

上部の「新規」「開く」「保存」を使います。Ctrl+N、Ctrl+O、Ctrl+S でも操作できます。本文の Undo / Redo は Ctrl+Z / Ctrl+Y です。未保存のまま別の文書を開く、新規作成する、またはアプリを閉じる際には確認が表示されます。

TXT は UTF-8 として読み書きします。既存ファイルの BOM と改行形式（LF、CRLF、CR）は保存時に維持します。未編集のファイルを保存すると元のバイト列をそのまま書き戻します。異なる種類の改行が混在する文書を編集して保存した場合、新しい内容の改行は最初に見つかった形式に統一されます。
