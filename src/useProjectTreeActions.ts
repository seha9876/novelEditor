/** プロジェクトツリーの名前入力、DB操作、ファイル開閉結果を表示構成から分離する。 */
import { computed, ref, type Ref } from 'vue'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { chooseTextFile, fileName } from './textFile'
import type { ProjectTreeOpenRequest, ProjectTreeOpenResult } from './projectTreeWindow'
import {
  createProject,
  createProjectFolder,
  deleteProject,
  registerProjectFile,
  registerDroppedProjectFiles,
  relinkProjectFile,
  removeProjectNodes,
  renameProject,
  renameProjectFolder,
  selectProject,
} from './projectTreeClient'
import type { ProjectTreeNode, ProjectTreeSnapshot } from './projectTreeModel'

type ProjectTreeDialogMode = 'project-create' | 'project-rename' | 'folder-create' | 'folder-rename'
type ProjectTreeDocumentOrigin = { nodeId: number; projectId: number }

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
  const activeProject = computed(() => options.snapshot.value.projects.find((project) => project.id === options.snapshot.value.activeProjectId) ?? null)
  const contextNodeId = ref<number | null>(null)
  const contextNode = computed(() => options.snapshot.value.nodes.find((node) => node.id === contextNodeId.value) ?? null)
  const nodeMenuOpen = ref(false)
  const nodeMenuTarget = ref<[number, number]>([0, 0])
  const projectMenuOpen = ref(false)
  const dialogOpen = ref(false)
  const dialogMode = ref<ProjectTreeDialogMode>('project-create')
  const dialogTitle = ref('')
  const dialogValue = ref('')
  const dialogProjectId = ref<number | null>(null)
  const dialogParentId = ref<number | null>(null)
  const dialogNodeId = ref<number | null>(null)

  /** 入力ダイアログを開き、必要な対象 ID を保持する。 */
  function openNameDialog(mode: ProjectTreeDialogMode, title: string, initialValue: string, ids: { projectId?: number | null; parentId?: number | null; nodeId?: number | null } = {}): void {
    dialogMode.value = mode
    dialogTitle.value = title
    dialogValue.value = initialValue
    dialogProjectId.value = ids.projectId ?? null
    dialogParentId.value = ids.parentId ?? null
    dialogNodeId.value = ids.nodeId ?? null
    dialogOpen.value = true
  }

  /** 名前入力を検証し、対応するプロジェクトまたは仮想フォルダを保存する。 */
  async function saveNameDialog(): Promise<void> {
    const name = dialogValue.value.trim()
    if (!name || options.isBusy()) return
    const previousNodeIds = new Set(options.snapshot.value.nodes.map((node) => node.id))
    const previousProjectIds = new Set(options.snapshot.value.projects.map((project) => project.id))

    if (dialogMode.value === 'project-create') {
      if (!await options.runMutation(() => createProject(name))) return
      dialogOpen.value = false
      const created = options.snapshot.value.projects.find((project) => !previousProjectIds.has(project.id))
      if (created && options.snapshot.value.activeProjectId !== created.id) {
        await options.runMutation(() => selectProject(created.id))
      }
      return
    }

    let action: () => Promise<void>
    if (dialogMode.value === 'project-rename' && dialogProjectId.value !== null) {
      action = () => renameProject(dialogProjectId.value!, name)
    } else if (dialogMode.value === 'folder-create' && options.snapshot.value.activeProjectId !== null) {
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

  /** プロジェクト選択を保存してから表示を切り替える。 */
  async function changeProject(projectId: number | null): Promise<void> {
    if (projectId === null || projectId === options.snapshot.value.activeProjectId) return
    options.clearNodeSelection()
    await options.runMutation(() => selectProject(projectId))
  }

  /** 新しいプロジェクトを作成するための入力を求める。 */
  function requestProjectCreate(): void {
    openNameDialog('project-create', 'プロジェクトを作成', '')
  }

  /** 選択中プロジェクト名の変更を求める。 */
  function requestProjectRename(): void {
    if (!activeProject.value) return
    projectMenuOpen.value = false
    openNameDialog('project-rename', 'プロジェクト名を変更', activeProject.value.name, { projectId: activeProject.value.id })
  }

  /** 選択中プロジェクトと登録情報だけを確認後に削除する。 */
  async function requestProjectDelete(): Promise<void> {
    const project = activeProject.value
    if (!project || options.isBusy()) return
    projectMenuOpen.value = false
    if (!await ask(`「${project.name}」と配下の登録を削除します。実ファイルは削除されません。続けますか？`, {
      title: 'プロジェクトの削除', kind: 'warning', okLabel: '削除', cancelLabel: 'キャンセル',
    })) return

    const origin = options.documentOrigin()
    if (await options.runMutation(() => deleteProject(project.id)) && origin?.projectId === project.id) {
      options.onOriginDetached(origin.nodeId)
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
    contextNodeId.value = node.id
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
    contextNode,
    nodeMenuOpen,
    nodeMenuTarget,
    projectMenuOpen,
    dialogOpen,
    dialogTitle,
    dialogValue,
    openNameDialog,
    saveNameDialog,
    changeProject,
    requestProjectCreate,
    requestProjectRename,
    requestProjectDelete,
    registerFile,
    registerDroppedFiles,
    requestFolderCreate,
    openNodeMenu,
    openTreeFile,
    applyOpenResult,
    requestNodeRemove,
    requestRelink,
  }
}
