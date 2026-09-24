// プロジェクトツリーのTauriコマンドと画面間で共有する型をまとめる。
import { invoke } from '@tauri-apps/api/core'

export interface ProjectTreeProject {
  id: number
  name: string
}

export type ProjectTreeNodeKind = 'folder' | 'file'

export interface ProjectTreeNode {
  id: number
  projectId: number
  parentId: number | null
  kind: ProjectTreeNodeKind
  name: string
  path: string | null
}

export interface ProjectTreeSnapshot {
  projects: ProjectTreeProject[]
  nodes: ProjectTreeNode[]
  activeProjectId: number | null
}

export type ProjectTreePlacement = 'before' | 'after' | 'inside' | 'root_end'

/** 保存済みのプロジェクトとノードを読み込む。 */
export function loadProjectTreeSnapshot(): Promise<ProjectTreeSnapshot> {
  return invoke<ProjectTreeSnapshot>('project_tree_snapshot')
}

/** 新しいプロジェクトを作成する。 */
export function createProject(name: string): Promise<void> {
  return invoke('project_create', { name })
}

/** プロジェクト名を変更する。 */
export function renameProject(projectId: number, name: string): Promise<void> {
  return invoke('project_rename', { projectId, name })
}

/** プロジェクトと配下の登録情報を削除する。 */
export function deleteProject(projectId: number): Promise<void> {
  return invoke('project_delete', { projectId })
}

/** 表示中のプロジェクトを選択状態として保存する。 */
export function selectProject(projectId: number): Promise<void> {
  return invoke('project_select', { projectId })
}

/** 指定した階層に仮想フォルダを作成する。 */
export function createProjectFolder(projectId: number, parentId: number | null, name: string): Promise<void> {
  return invoke('project_folder_create', { projectId, parentId, name })
}

/** 仮想フォルダの表示名を変更する。 */
export function renameProjectFolder(nodeId: number, name: string): Promise<void> {
  return invoke('project_folder_rename', { nodeId, name })
}

/** 既存 TXT を指定したプロジェクト階層へ登録する。 */
export function registerProjectFile(projectId: number, parentId: number | null, path: string): Promise<void> {
  return invoke('project_file_register', { projectId, parentId, path })
}

/** 既存のファイルノードが参照するパスを変更する。 */
export function relinkProjectFile(nodeId: number, path: string): Promise<void> {
  return invoke('project_file_relink', { nodeId, path })
}

/** ノードと配下の登録情報を削除する。実ファイルは変更しない。 */
export function removeProjectNode(nodeId: number): Promise<void> {
  return invoke('project_node_remove', { nodeId })
}

/** ノードを指定した前後・フォルダ内・ルート末尾へ移動する。 */
export function moveProjectNode(
  nodeId: number,
  targetId: number | null,
  placement: ProjectTreePlacement,
): Promise<void> {
  return invoke('project_node_move', { nodeId, targetId, placement })
}

/** 登録ノードの参照先を確認し、読み書きできる範囲へ追加してパスを返す。 */
export function authorizeProjectFile(nodeId: number): Promise<string> {
  return invoke<string>('project_file_authorize', { nodeId })
}
