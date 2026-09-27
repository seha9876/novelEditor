// プロジェクトツリーのTauriコマンドを型付き関数としてまとめる。
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import type {
  ProjectTreePlacement,
  ProjectTreeSnapshot,
} from './projectTreeModel'
import { PROJECT_TREE_CHANGED_EVENT, type ProjectTreeChangedEvent } from './projectTreeWindow'

export interface ProjectTreeFileRegistrationFailure {
  path: string
  error: string
}

/** プロジェクト操作後の再読込を他のツリー画面へ通知する。 */
export function notifyProjectTreeChanged(sourceId: string, revision: number): Promise<void> {
  const payload: ProjectTreeChangedEvent = { sourceId, revision }
  return emit(PROJECT_TREE_CHANGED_EVENT, payload)
}

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

/** 複数 TXT の登録を個別に試し、失敗した項目があっても残りを続行する。 */
export async function registerDroppedProjectFiles(
  projectId: number,
  parentId: number | null,
  paths: string[],
): Promise<{ registeredCount: number; failures: ProjectTreeFileRegistrationFailure[] }> {
  let registeredCount = 0
  const failures: ProjectTreeFileRegistrationFailure[] = []
  for (const path of paths) {
    try {
      await registerProjectFile(projectId, parentId, path)
      registeredCount += 1
    } catch (error) {
      failures.push({ path, error: String(error) })
    }
  }
  return { registeredCount, failures }
}

/** 既存のファイルノードが参照するパスを変更する。 */
export function relinkProjectFile(nodeId: number, path: string): Promise<void> {
  return invoke('project_file_relink', { nodeId, path })
}

/** 複数ノードと配下の登録情報を一括削除する。実ファイルは変更しない。 */
export function removeProjectNodes(nodeIds: number[]): Promise<void> {
  return invoke('project_nodes_remove', { nodeIds })
}

/** ノードを指定した前後・フォルダ内・ルート末尾へ移動する。 */
export function moveProjectNode(
  nodeId: number,
  targetId: number | null,
  placement: ProjectTreePlacement,
): Promise<void> {
  return invoke('project_node_move', { nodeId, targetId, placement })
}

/** 登録ノードの参照先を確認し、アプリのファイル許可範囲へ追加したパスを返す。 */
export function authorizeProjectFile(nodeId: number): Promise<string> {
  return invoke<string>('project_file_authorize', { nodeId })
}
