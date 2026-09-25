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

export interface ProjectTreeFileRegistrationFailure {
  path: string
  error: string
}

export interface ProjectTreeSelectionModifiers {
  ctrlKey: boolean
  shiftKey: boolean
}

export interface ProjectTreeSelectionChange {
  selectedNodeIds: number[]
  anchorNodeId: number | null
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

/** 行上のポインター位置から、前・後・フォルダ内の挿入位置を決める。 */
export function projectTreeRowPlacement(
  kind: ProjectTreeNodeKind,
  pointerY: number,
  rowTop: number,
  rowHeight: number,
): Exclude<ProjectTreePlacement, 'root_end'> {
  const ratio = (pointerY - rowTop) / Math.max(rowHeight, 1)
  if (kind === 'folder' && ratio >= 0.25 && ratio <= 0.75) return 'inside'
  return ratio < 0.5 ? 'before' : 'after'
}

/** ツリー内かつ上下端の許容範囲にあるポインターから自動スクロール量を求める。 */
export function projectTreeAutoScrollStep(
  pointer: { x: number; y: number },
  bounds: { left: number; right: number; top: number; bottom: number },
  edgeSize = 40,
  maxStep = 18,
): number {
  if (pointer.x < bounds.left || pointer.x > bounds.right
    || pointer.y < bounds.top - edgeSize || pointer.y > bounds.bottom + edgeSize) return 0
  if (pointer.y < bounds.top + edgeSize) {
    return -Math.min(maxStep, Math.ceil((bounds.top + edgeSize - pointer.y) / 2))
  }
  if (pointer.y > bounds.bottom - edgeSize) {
    return Math.min(maxStep, Math.ceil((pointer.y - (bounds.bottom - edgeSize)) / 2))
  }
  return 0
}

/** ツリー領域内のドロップだけを受け付け、フォルダ行以外はルートを追加先にする。 */
export function projectTreeExternalDropDestination(
  isWithinTree: boolean,
  target: Pick<ProjectTreeNode, 'id' | 'kind'> | null,
): { accepted: false; parentId: null } | { accepted: true; parentId: number | null } {
  if (!isWithinTree) return { accepted: false, parentId: null }
  return {
    accepted: true,
    parentId: target?.kind === 'folder' ? target.id : null,
  }
}

/** Tauri の物理座標を WebView の CSS ピクセル座標へ変換する。 */
export function projectTreePhysicalToViewport(
  position: { x: number; y: number },
  scale: number,
): { x: number; y: number } {
  const safeScale = scale > 0 ? scale : 1
  return { x: position.x / safeScale, y: position.y / safeScale }
}

/** ポインター移動量がクリックとの区別に使う開始しきい値へ達したか判定する。 */
export function hasProjectTreePointerDragStarted(
  start: { x: number; y: number },
  current: { x: number; y: number },
  threshold = 5,
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold
}

/** ポインター移動後に発生するマウス由来の合成クリックだけを抑止する。 */
export function shouldSuppressProjectTreeClick(suppressGeneratedClick: boolean, clickDetail: number): boolean {
  return suppressGeneratedClick && clickDetail > 0
}

/** 可視行の順序を保ったまま、クリックによるツリー選択を更新する。 */
export function projectTreeSelectionAfterClick(
  visibleNodeIds: number[],
  selectedNodeIds: ReadonlySet<number>,
  anchorNodeId: number | null,
  nodeId: number,
  modifiers: ProjectTreeSelectionModifiers,
): ProjectTreeSelectionChange {
  const targetIndex = visibleNodeIds.indexOf(nodeId)
  if (targetIndex < 0) {
    return {
      selectedNodeIds: visibleNodeIds.filter((id) => selectedNodeIds.has(id)),
      anchorNodeId,
    }
  }

  const currentSelection = new Set(visibleNodeIds.filter((id) => selectedNodeIds.has(id)))
  if (modifiers.shiftKey) {
    const anchorIndex = anchorNodeId === null ? -1 : visibleNodeIds.indexOf(anchorNodeId)
    const rangeStart = anchorIndex < 0 ? targetIndex : Math.min(anchorIndex, targetIndex)
    const rangeEnd = anchorIndex < 0 ? targetIndex : Math.max(anchorIndex, targetIndex)
    const range = visibleNodeIds.slice(rangeStart, rangeEnd + 1)
    const nextSelection = modifiers.ctrlKey ? currentSelection : new Set<number>()
    for (const id of range) nextSelection.add(id)
    return {
      selectedNodeIds: visibleNodeIds.filter((id) => nextSelection.has(id)),
      anchorNodeId: anchorIndex < 0 ? nodeId : anchorNodeId,
    }
  }

  if (modifiers.ctrlKey) {
    if (currentSelection.has(nodeId)) currentSelection.delete(nodeId)
    else currentSelection.add(nodeId)
    return {
      selectedNodeIds: visibleNodeIds.filter((id) => currentSelection.has(id)),
      anchorNodeId: nodeId,
    }
  }

  return { selectedNodeIds: [nodeId], anchorNodeId: nodeId }
}

/** 右クリックや操作メニューの対象を選択状態へ反映する。 */
export function projectTreeSelectionAfterContextMenu(
  visibleNodeIds: number[],
  selectedNodeIds: ReadonlySet<number>,
  nodeId: number,
): ProjectTreeSelectionChange {
  const currentSelection = new Set(visibleNodeIds.filter((id) => selectedNodeIds.has(id)))
  if (!currentSelection.has(nodeId)) return { selectedNodeIds: [nodeId], anchorNodeId: nodeId }
  return {
    selectedNodeIds: visibleNodeIds.filter((id) => currentSelection.has(id)),
    anchorNodeId: nodeId,
  }
}

/** 保存済みノードだけを残し、プロジェクト切替・再読込後の選択状態を整理する。 */
export function projectTreeSelectionForNodes(
  selectedNodeIds: ReadonlySet<number>,
  nodes: readonly Pick<ProjectTreeNode, 'id' | 'projectId'>[],
  projectId: number | null,
): number[] {
  if (projectId === null) return []
  const validIds = new Set(nodes.filter((node) => node.projectId === projectId).map((node) => node.id))
  return [...selectedNodeIds].filter((id) => validIds.has(id))
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
