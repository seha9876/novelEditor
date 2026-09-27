/** プロジェクト単位の作成・切替・名称変更・削除をノード操作から分離する。 */
import { computed, ref, type Ref } from 'vue'
import { ask } from '@tauri-apps/plugin-dialog'
import {
  createProject,
  deleteProject,
  renameProject,
  selectProject,
} from './projectTreeClient'
import type { ProjectTreeSnapshot } from './projectTreeModel'

type RunMutation = (action: () => Promise<void>) => Promise<boolean>
type DocumentOrigin = { nodeId: number; projectId: number }

export type ProjectTreeProjectActionsOptions = {
  snapshot: Ref<ProjectTreeSnapshot>
  isBusy: () => boolean
  runMutation: RunMutation
  documentOrigin?: () => DocumentOrigin | null
  clearNodeSelection?: () => void
  onOriginDetached?: (nodeId: number) => void
}
/** プロジェクト名入力と操作確認を共有し、Sidebarとメニューバーから同じ処理を呼べるようにする。 */
export function useProjectTreeProjectActions(options: ProjectTreeProjectActionsOptions) {
  const activeProject = computed(() => options.snapshot.value.projects.find((project) => project.id === options.snapshot.value.activeProjectId) ?? null)
  const projectDialogOpen = ref(false)
  const projectDialogMode = ref<'create' | 'rename'>('create')
  const projectDialogTitle = ref('')
  const projectDialogValue = ref('')
  const projectDialogProjectId = ref<number | null>(null)

  /** プロジェクト名入力ダイアログを開き、名称変更対象を保持する。 */
  function openProjectDialog(mode: 'create' | 'rename', title: string, initialValue: string, projectId: number | null = null): void {
    if (options.isBusy()) return
    projectDialogMode.value = mode
    projectDialogTitle.value = title
    projectDialogValue.value = initialValue
    projectDialogProjectId.value = projectId
    projectDialogOpen.value = true
  }

  /** 入力値を検証し、プロジェクトの作成または名称変更を保存する。 */
  async function saveProjectDialog(): Promise<void> {
    const name = projectDialogValue.value.trim()
    if (!name || options.isBusy()) return
    const previousProjectIds = new Set(options.snapshot.value.projects.map((project) => project.id))
    const projectId = projectDialogProjectId.value
    const action = projectDialogMode.value === 'create'
      ? () => createProject(name)
      : projectId === null ? null : () => renameProject(projectId, name)
    if (!action || !await options.runMutation(action)) return

    projectDialogOpen.value = false
    if (projectDialogMode.value !== 'create') return
    const createdProject = options.snapshot.value.projects.find((project) => !previousProjectIds.has(project.id))
    if (createdProject && options.snapshot.value.activeProjectId !== createdProject.id) {
      await changeProject(createdProject.id)
    }
  }

  /** プロジェクトを選択状態として保存し、表示側のノード選択を解除する。 */
  async function changeProject(projectId: number | null): Promise<void> {
    if (projectId === null || projectId === options.snapshot.value.activeProjectId || options.isBusy()) return
    options.clearNodeSelection?.()
    await options.runMutation(() => selectProject(projectId))
  }

  /** 新しいプロジェクトの名前入力を開始する。 */
  function requestProjectCreate(): void {
    openProjectDialog('create', 'プロジェクトを作成', '')
  }

  /** 選択中プロジェクトの名前入力を開始する。 */
  function requestProjectRename(): void {
    if (!activeProject.value) return
    openProjectDialog('rename', 'プロジェクト名を変更', activeProject.value.name, activeProject.value.id)
  }

  /** 選択中プロジェクトの登録情報を確認後に削除する。 */
  async function requestProjectDelete(): Promise<void> {
    const project = activeProject.value
    if (!project || options.isBusy()) return
    const confirmed = await ask(`「${project.name}」と配下の登録を削除します。実ファイルは削除されません。続けますか？`, {
      title: 'プロジェクトの削除', kind: 'warning', okLabel: '削除', cancelLabel: 'キャンセル',
    })
    if (!confirmed || !await options.runMutation(() => deleteProject(project.id))) return
    const origin = options.documentOrigin?.()
    if (origin?.projectId === project.id) options.onOriginDetached?.(origin.nodeId)
  }

  return {
    activeProject,
    projectDialogOpen,
    projectDialogTitle,
    projectDialogValue,
    saveProjectDialog,
    requestProjectCreate,
    requestProjectRename,
    requestProjectDelete,
    changeProject,
  }
}
