//! SQLite 永続化と Tauri コマンドを通じてプロジェクトツリーを管理する。

use std::{path::PathBuf, sync::Mutex};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{State, Window};

mod database;
mod nodes;
mod ordering;
mod projects;
mod queries;

use database::initialize_database;

/// 起動時の DB 障害をアプリ全体の起動失敗にせず、ツリー操作だけで報告する状態。
pub struct ProjectTreeState {
    connection: Mutex<Option<Connection>>,
    initialization_error: Mutex<Option<String>>,
}

impl ProjectTreeState {
    /// 指定された保存先の DB を開き、必要なテーブルを準備する。
    pub fn initialize(database_path: Result<PathBuf, String>) -> Self {
        let initialized = database_path.and_then(initialize_database);
        match initialized {
            Ok(connection) => Self {
                connection: Mutex::new(Some(connection)),
                initialization_error: Mutex::new(None),
            },
            Err(error) => Self {
                connection: Mutex::new(None),
                initialization_error: Mutex::new(Some(error)),
            },
        }
    }

    /// 保存先の復旧後に DB 接続を再初期化する。
    pub fn reinitialize(&self, database_path: Result<PathBuf, String>) -> Result<(), String> {
        let initialized = database_path.and_then(initialize_database);
        match initialized {
            Ok(connection) => {
                *self
                    .connection
                    .lock()
                    .map_err(|_| "プロジェクトツリー DB のロックに失敗しました".to_string())? =
                    Some(connection);
                *self
                    .initialization_error
                    .lock()
                    .map_err(|_| "プロジェクトツリー DB の状態確認に失敗しました".to_string())? =
                    None;
                Ok(())
            }
            Err(error) => {
                *self
                    .connection
                    .lock()
                    .map_err(|_| "プロジェクトツリー DB のロックに失敗しました".to_string())? =
                    None;
                *self
                    .initialization_error
                    .lock()
                    .map_err(|_| "プロジェクトツリー DB の状態確認に失敗しました".to_string())? =
                    Some(error.clone());
                Err(error)
            }
        }
    }

    /// 起動時 DB 初期化が失敗している場合に、その理由を保存先状態へ伝える。
    pub fn initialization_error(&self) -> Result<Option<String>, String> {
        self.initialization_error
            .lock()
            .map(|error| error.clone())
            .map_err(|_| "プロジェクトツリー DB の状態確認に失敗しました".to_string())
    }
}

/// クライアントに返すプロジェクト情報。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    id: i64,
    name: String,
}

/// クライアントに返すツリーノード情報。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNodeInfo {
    id: i64,
    project_id: i64,
    parent_id: Option<i64>,
    kind: String,
    name: String,
    path: Option<String>,
}

/// サイドバーが必要とする永続化済みツリー状態。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTreeSnapshot {
    projects: Vec<ProjectInfo>,
    nodes: Vec<ProjectNodeInfo>,
    active_project_id: Option<i64>,
}

/// 永続化した全ツリーと選択中プロジェクトを返す。
#[tauri::command]
pub fn project_tree_snapshot(
    state: State<'_, ProjectTreeState>,
) -> Result<ProjectTreeSnapshot, String> {
    queries::snapshot(state.inner())
}

/// 新しいプロジェクトを作成し、初回なら選択中にもする。
#[tauri::command]
pub fn project_create(state: State<'_, ProjectTreeState>, name: String) -> Result<(), String> {
    projects::create_project(state.inner(), name)
}

/// プロジェクト名を変更する。
#[tauri::command]
pub fn project_rename(
    state: State<'_, ProjectTreeState>,
    project_id: i64,
    name: String,
) -> Result<(), String> {
    projects::rename_project(state.inner(), project_id, name)
}

/// プロジェクトとツリー登録だけを削除し、選択先を同一トランザクションで補正する。
#[tauri::command]
pub fn project_delete(state: State<'_, ProjectTreeState>, project_id: i64) -> Result<(), String> {
    projects::delete_project(state.inner(), project_id)
}

/// サイドバーで選択したプロジェクトを保存する。
#[tauri::command]
pub fn project_select(state: State<'_, ProjectTreeState>, project_id: i64) -> Result<(), String> {
    projects::select_project(state.inner(), project_id)
}

/// 指定階層に仮想フォルダを追加する。
#[tauri::command]
pub fn project_folder_create(
    state: State<'_, ProjectTreeState>,
    project_id: i64,
    parent_id: Option<i64>,
    name: String,
) -> Result<(), String> {
    nodes::create_folder(state.inner(), project_id, parent_id, name)
}

/// 仮想フォルダの表示名を変更する。
#[tauri::command]
pub fn project_folder_rename(
    state: State<'_, ProjectTreeState>,
    node_id: i64,
    name: String,
) -> Result<(), String> {
    nodes::rename_folder(state.inner(), node_id, name)
}

/// ダイアログまたはOSからのドロップで受け取った TXT をツリーへ独立した参照として登録する。
#[tauri::command]
pub fn project_file_register(
    state: State<'_, ProjectTreeState>,
    window: Window,
    project_id: i64,
    parent_id: Option<i64>,
    path: String,
) -> Result<(), String> {
    nodes::register_file(state.inner(), window, project_id, parent_id, path)
}

/// 既存のファイル参照を、ダイアログで選択した TXT に付け替える。
#[tauri::command]
pub fn project_file_relink(
    state: State<'_, ProjectTreeState>,
    window: Window,
    node_id: i64,
    path: String,
) -> Result<(), String> {
    nodes::relink_file(state.inner(), window, node_id, path)
}

/// ノード登録だけを一括削除し、実ファイルには触れない。
#[tauri::command]
pub fn project_nodes_remove(
    state: State<'_, ProjectTreeState>,
    node_ids: Vec<i64>,
) -> Result<(), String> {
    nodes::remove_nodes(state.inner(), node_ids)
}

/// ノードを同一プロジェクト内で並べ替え、必要な場合だけ移動先兄弟を再採番する。
#[tauri::command]
pub fn project_node_move(
    state: State<'_, ProjectTreeState>,
    node_id: i64,
    target_id: Option<i64>,
    placement: String,
) -> Result<(), String> {
    nodes::move_node(state.inner(), node_id, target_id, placement)
}

/// 保存済みノードの参照先を検証し、アプリ管理の FS Scope へ追加する。
#[tauri::command]
pub fn project_file_authorize(
    state: State<'_, ProjectTreeState>,
    window: Window,
    node_id: i64,
) -> Result<String, String> {
    nodes::authorize_file(state.inner(), window, node_id)
}
pub(crate) use database::{
    is_empty_database_file, prepare_new_database_file, validate_database_file,
};
