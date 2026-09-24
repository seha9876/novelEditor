/** プロジェクトツリー分離ウィンドウとメイン画面のイベント契約をまとめる。 */
export const PROJECT_TREE_WINDOW_COMMAND_EVENT = 'project-tree-window:command'
export const PROJECT_TREE_WINDOW_STATE_EVENT = 'project-tree-window:state'

export type ProjectTreeOpenResult = {
  requestId: string
  nodeId: number
  error?: string
  unavailable?: boolean
}

export type ProjectTreeWindowState = {
  windowId: string
  revision: number
  disabled: boolean
  documentOrigin: { nodeId: number; projectId: number } | null
  expandedFolderIds: number[]
  unavailableNodeIds: number[]
  openResult?: ProjectTreeOpenResult
}

export type ProjectTreeOpenRequest = {
  requestId: string
  nodeId: number
  projectId: number
}

export type ProjectTreeWindowCommand =
  | { type: 'ready'; windowId: string }
  | { type: 'dock'; windowId: string; expandedFolderIds?: number[]; unavailableNodeIds?: number[] }
  | { type: 'open-file'; windowId: string; request: ProjectTreeOpenRequest }
  | { type: 'open-result-applied'; windowId: string; requestId: string }
  | { type: 'origin-detached'; windowId: string; nodeId: number }
  | { type: 'expanded-change'; windowId: string; nodeIds: number[] }
  | { type: 'unavailable-change'; windowId: string; nodeIds: number[] }

export type ProjectTreeWindowCommandPayload = ProjectTreeWindowCommand extends infer Command
  ? Command extends { windowId: string } ? Omit<Command, 'windowId'> : never
  : never

