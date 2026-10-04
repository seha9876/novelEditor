/** メインメニューから利用するプロジェクト一覧と共有CRUDを組み立てる。 */
import { computed, ref, type Ref } from 'vue'
import { loadProjectTreeSnapshot } from './projectTreeClient'
import { useProjectTreeProjectActions } from './useProjectTreeProjectActions'
import { useProjectTreeStore } from './useProjectTreeStore'

type ProjectDocumentOrigin = { nodeId: number; projectId: number }

export type ProjectTreeProjectControllerOptions = {
  disabled: Ref<boolean>
  documentOrigin: Ref<ProjectDocumentOrigin | null>
  showError: (error: unknown) => Promise<void>
  onOriginDetached: (nodeId: number) => void
}
/** メニューバー専用の一覧読込を所有し、Sidebarと同じイベント同期を利用する。 */
export function useProjectTreeProjectController(options: ProjectTreeProjectControllerOptions) {
  const store = useProjectTreeStore({
    loadSnapshot: loadProjectTreeSnapshot,
    canMutate: () => !options.disabled.value,
    showError: options.showError,
  })
  const projectActions = useProjectTreeProjectActions({
    snapshot: store.snapshot,
    isBusy: () => options.disabled.value || store.loading.value || store.mutationPending.value || Boolean(store.treeError.value),
    runMutation: store.runMutation,
    documentOrigin: () => options.documentOrigin.value,
    onOriginDetached: options.onOriginDetached,
  })

  const projects = computed(() => store.snapshot.value.projects)
  const activeProjectId = computed(() => store.snapshot.value.activeProjectId)
  const busy = computed(() => options.disabled.value || store.loading.value || store.mutationPending.value || Boolean(store.treeError.value))
  const disposed = ref(false)

  /** メニューバーの表示前にプロジェクト一覧の購読と初回読込を開始する。 */
  async function setup(): Promise<void> {
    if (disposed.value) return
    await store.setup()
    if (disposed.value) return
    await store.initializeTree()
  }

  /** 購読と保留中のStore処理を破棄する。 */
  function dispose(): void {
    if (disposed.value) return
    disposed.value = true
    store.dispose()
  }

  return {
    snapshot: computed(() => store.snapshot.value),
    projects,
    activeProjectId,
    busy,
    projectDialogOpen: projectActions.projectDialogOpen,
    projectDialogTitle: projectActions.projectDialogTitle,
    projectDialogValue: projectActions.projectDialogValue,
    projectDialogSave: projectActions.saveProjectDialog,
    requestProjectCreate: projectActions.requestProjectCreate,
    requestProjectRename: projectActions.requestProjectRename,
    requestProjectDelete: projectActions.requestProjectDelete,
    changeProject: projectActions.changeProject,
    setup,
    dispose,
  }
}
