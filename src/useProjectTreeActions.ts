/** プロジェクトツリーの名前入力、DB操作、ファイル開閉結果を表示構成から分離する。 */
import { computed, ref, watch, type Ref } from 'vue'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { chooseTextFile, fileName } from './textFile'
import type { ProjectTreeOpenRequest, ProjectTreeOpenResult } from './projectTreeWindow'
import {
  createProjectFolder,
  registerProjectFile,
  registerDroppedProjectFiles,
  relinkProjectFile,
  removeProjectNodes,
  renameProjectFolder,
} from './projectTreeClient'
import type { ProjectTreeNode, ProjectTreeSnapshot } from './projectTreeModel'
import { useProjectTreeProjectActions } from './useProjectTreeProjectActions'

type ProjectTreeDialogMode = 'folder-create' | 'folder-rename'
type ProjectTreeDocumentOrigin = { nodeId: number; projectId: number }
type ProjectTreeContextTarget = { kind: 'root' } | { kind: 'node'; nodeId: number }

type RunMutation = (action: () => Promise<void>, options?: { setErrorOnFailure?: boolean }) => Promise<boolean>

type ProjectTreeActionsOptions = {
  snapshot: Ref<ProjectTreeSnapshot>
  pendingOpenRequest: Ref<ProjectTreeOpenRequest | null>
  documentOrigin: () => ProjectTreeDocumentOrigin | null
  selectedNodes: () => ProjectTreeNode[]
  unavailableNodeIds: () => number[]
  isBusy: () => boolean
  runMutation: RunMutation
  showTreeError: (error: unknown) => Promise<void>
  setUnavailableNodeIds: (nodeIds: number[]) => void
  clearNodeSelection: () => void
  selectNodeFromContextMenu: (node: ProjectTreeNode) => void
  expandFolderPath: (folderId: number | null) => void
  containsNode: (parentId: number, candidateId: number) => boolean
  onOpenFile: (request: ProjectTreeOpenRequest) => void
  onOpenResultApplied: (requestId: string) => void
  onOriginDetached: (nodeId: number) => void
}

/** ツリー操作に必要なダイアログ・保留要求・DB更新を所有する。 */
export function useProjectTreeActions(options: ProjectTreeActionsOptions) {
  const contextTarget = ref<ProjectTreeContextTarget>({ kind: 'root' })
  const contextNode = computed(() => {
    const target = contextTarget.value
    return target.kind === 'node'
      ? options.snapshot.value.nodes.find((node) => node.id === target.nodeId) ?? null
      : null
  })
  const nodeMenuOpen = ref(false)
  const nodeMenuTarget = ref<[number, number]>([0, 0])
  /** アクティブプロジェクト切替時に古い対象の操作メニューを閉じる。 */
  watch(() => options.snapshot.value.activeProjectId, () => {
    nodeMenuOpen.value = false
  })
  const dialogOpen = ref(false)
  const dialogMode = ref<ProjectTreeDialogMode>('folder-create')
  const dialogTitle = ref('')
  const dialogValue = ref('')
  const dialogParentId = ref<number | null>(null)
  const dialogNodeId = ref<number | null>(null)

  const projectActions = useProjectTreeProjectActions({
    snapshot: options.snapshot,
    isBusy: options.isBusy,
    runMutation: options.runMutation,
    documentOrigin: options.documentOrigin,
    clearNodeSelection: options.clearNodeSelection,
    onOriginDetached: options.onOriginDetached,
  })

  /** 入力ダイアログを開き、必要な対象 ID を保持する。 */
  function openNameDialog(mode: ProjectTreeDialogMode, title: string, initialValue: string, ids: { parentId?: number | null; nodeId?: number | null } = {}): void {
    dialogMode.value = mode
    dialogTitle.value = title
    dialogValue.value = initialValue
    dialogParentId.value = ids.parentId ?? null
    dialogNodeId.value = ids.nodeId ?? null
    dialogOpen.value = true
  }

  /** 名前入力を検証し、仮想フォルダを保存する。 */
  async function saveNameDialog(): Promise<void> {
    const name = dialogValue.value.trim()
    if (!name || options.isBusy()) return
    const previousNodeIds = new Set(options.snapshot.value.nodes.map((node) => node.id))

    let action: () => Promise<void>
    if (dialogMode.value === 'folder-create' && options.snapshot.value.activeProjectId !== null) {
      action = () => createProjectFolder(options.snapshot.value.activeProjectId!, dialogParentId.value, name)
    } else if (dialogMode.value === 'folder-rename' && dialogNodeId.value !== null) {
      action = () => renameProjectFolder(dialogNodeId.value!, name)
    } else {
      return
    }

    if (await options.runMutation(action)) {
      dialogOpen.value = false
      if (dialogMode.value === 'folder-create') {
        const createdFolder = options.snapshot.value.nodes.find((node) => !previousNodeIds.has(node.id)
          && node.kind === 'folder' && node.name === name
          && node.parentId === dialogParentId.value && node.projectId === options.snapshot.value.activeProjectId)
        if (createdFolder) options.expandFolderPath(createdFolder.id)
      }
    }
  }

  /** ルートまたは選択フォルダへ TXT を登録する。選択ダイアログ取消時は状態を変えない。 */
  async function registerFile(parentId: number | null = null): Promise<void> {
    const projectId = options.snapshot.value.activeProjectId
    if (projectId === null || options.isBusy()) return
    const path = await chooseTextFile()
    if (!path) return
    if (await options.runMutation(() => registerProjectFile(projectId, parentId, path))) options.expandFolderPath(parentId)
  }

  /** 外部からドロップされた複数パスを個別に登録し、失敗分だけまとめて通知する。 */
  async function registerDroppedFiles(paths: string[], parentId: number | null): Promise<void> {
    const projectId = options.snapshot.value.activeProjectId
    if (!paths.length || options.isBusy()) return
    if (projectId === null) {
      await message('TXTを登録するプロジェクトを先に作成してください。', {
        title: 'TXTのドロップ登録', kind: 'warning',
      })
      return
    }

    let registeredCount = 0
    let failures: { path: string; error: string }[] = []
    const succeeded = await options.runMutation(async () => {
      const result = await registerDroppedProjectFiles(projectId, parentId, paths)
      registeredCount = result.registeredCount
      failures = result.failures
    }, { setErrorOnFailure: true })
    if (!succeeded) return
    if (registeredCount > 0) options.expandFolderPath(parentId)
    if (failures.length === 0) return

    const details = failures.slice(0, 5).map(({ path, error }) => `・${fileName(path)}: ${error}`)
    if (failures.length > details.length) details.push(`・ほか${failures.length - details.length}件`)
    const summary = registeredCount > 0
      ? `TXTを${registeredCount}件登録しました。${failures.length}件は登録できませんでした。`
      : `TXTを登録できませんでした（${failures.length}件）。`
    await message(`${summary}\n${details.join('\n')}`, {
      title: 'TXTのドロップ登録', kind: registeredCount > 0 ? 'warning' : 'error',
    })
  }

  /** ルートまたは指定フォルダへ仮想フォルダを作成する。 */
  function requestFolderCreate(parentId: number | null = null): void {
    if (options.snapshot.value.activeProjectId === null) return
    nodeMenuOpen.value = false
    openNameDialog('folder-create', '仮想フォルダを作成', '', { parentId })
  }

  /** ノードの操作メニューをポインター位置へ開く。 */
  function openNodeMenu(event: MouseEvent, node: ProjectTreeNode): void {
    event.preventDefault()
    event.stopPropagation()
    options.selectNodeFromContextMenu(node)
    contextTarget.value = { kind: 'node', nodeId: node.id }
    nodeMenuTarget.value = [event.clientX, event.clientY]
    nodeMenuOpen.value = true
  }

  /** ツリーの空欄を現在プロジェクトのルートとして操作メニューを開く。 */
  function openRootMenu(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    if (options.snapshot.value.activeProjectId === null) return
    options.clearNodeSelection()
    contextTarget.value = { kind: 'root' }
    nodeMenuTarget.value = [event.clientX, event.clientY]
    nodeMenuOpen.value = true
  }

  /** 登録ファイルをメイン画面へ開くよう依頼し、参照先の検証と読み込み結果を待つ。 */
  async function openTreeFile(node: ProjectTreeNode): Promise<void> {
    if (options.isBusy()) return
    const request = { requestId: crypto.randomUUID(), nodeId: node.id, projectId: node.projectId }
    options.pendingOpenRequest.value = request
    options.onOpenFile(request)
  }

  /** メイン画面から返された開く結果を反映し、失敗した行へ再指定の目印を付ける。 */
  async function applyOpenResult(result: ProjectTreeOpenResult | null | undefined): Promise<void> {
    if (!result || result.requestId !== options.pendingOpenRequest.value?.requestId) return
    options.pendingOpenRequest.value = null
    try {
      const next = new Set(options.unavailableNodeIds())
      if (result.error) {
        if (result.unavailable) next.add(result.nodeId)
      } else next.delete(result.nodeId)
      options.setUnavailableNodeIds([...next])
      if (result.error) await options.showTreeError(result.error)
    } catch (error) {
      console.error('プロジェクトツリーのエラー通知を表示できませんでした。', error)
    } finally {
      options.onOpenResultApplied(result.requestId)
    }
  }

  /** 選択したノードと配下の登録情報を確認後に一括削除し、対象文書の出自だけを解除する。 */
  async function requestNodeRemove(): Promise<void> {
    const nodes = options.selectedNodes()
    if (!nodes.length || options.isBusy()) return
    nodeMenuOpen.value = false
    const count = nodes.length
    const description = count === 1
      ? `「${nodes[0].name}」の${nodes[0].kind === 'folder' ? '仮想フォルダと配下の登録' : 'ファイルの登録'}`
      : `選択した${count}件の登録`
    if (!await ask(`${description}を解除します。実ファイルは削除されません。続けますか？`, {
      title: '登録の解除', kind: 'warning', okLabel: '登録解除', cancelLabel: 'キャンセル',
    })) return

    const originNodeId = options.documentOrigin()?.nodeId
    const removeOrigin = originNodeId !== undefined && nodes.some((node) => options.containsNode(node.id, originNodeId))
    const nodeIds = nodes.map((node) => node.id)
    if (await options.runMutation(() => removeProjectNodes(nodeIds))) {
      options.clearNodeSelection()
      if (removeOrigin) options.onOriginDetached(originNodeId)
    }
  }

  /** 選択ファイルを再指定し、成功後にそのノードの出自紐付けを解除する。 */
  async function requestRelink(): Promise<void> {
    const node = contextNode.value
    if (!node || node.kind !== 'file' || options.isBusy()) return
    nodeMenuOpen.value = false
    const path = await chooseTextFile()
    if (!path) return
    if (await options.runMutation(() => relinkProjectFile(node.id, path))) {
      options.setUnavailableNodeIds(options.unavailableNodeIds().filter((nodeId) => nodeId !== node.id))
      if (options.documentOrigin()?.nodeId === node.id) options.onOriginDetached(node.id)
    }
  }

  return {
    contextTarget,
    contextNode,
    nodeMenuOpen,
    nodeMenuTarget,
    dialogOpen,
    dialogTitle,
    dialogValue,
    openNameDialog,
    saveNameDialog,
    activeProject: projectActions.activeProject,
    projectDialogOpen: projectActions.projectDialogOpen,
    projectDialogTitle: projectActions.projectDialogTitle,
    projectDialogValue: projectActions.projectDialogValue,
    saveProjectDialog: projectActions.saveProjectDialog,
    requestProjectCreate: projectActions.requestProjectCreate,
    requestProjectRename: projectActions.requestProjectRename,
    requestProjectDelete: projectActions.requestProjectDelete,
    changeProject: projectActions.changeProject,
    registerFile,
    registerDroppedFiles,
    requestFolderCreate,
    openNodeMenu,
    openRootMenu,
    openTreeFile,
    applyOpenResult,
    requestNodeRemove,
    requestRelink,
  }
}
