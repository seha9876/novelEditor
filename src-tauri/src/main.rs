#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// デスクトップアプリのエントリポイント。実際の Tauri 構成はライブラリ側にまとめる。
fn main() {
    novel_editor_lib::run()
}
