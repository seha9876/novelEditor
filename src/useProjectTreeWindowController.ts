/** プロジェクトツリーの表示レイアウトと分離子窓Controllerを組み合わせる。 */
import { ref, type Ref } from 'vue'
import type { ApplicationPreferencesV1 } from './appPreferenceSchema'
import type { ProjectTreeOpenRequest } from './projectTreeWindow'
import { useDetachedProjectTreeWindow, type DetachedProjectTreeDocumentOrigin } from './useDetachedProjectTreeWindow'
import { useProjectTreePaneLayout } from './useProjectTreePaneLayout'

type ProjectTreeDocumentOrigin = DetachedProjectTreeDocumentOrigin

type ProjectTreeWindowControllerOptions = {
  initialPreferences: ApplicationPreferencesV1
  busy: Ref<boolean>
  documentLocked: Ref<boolean>
  documentOrigin: Ref<ProjectTreeDocumentOrigin | null>
  mainCloseInProgress: Ref<boolean>
  showPersistenceNotice: (text: string) => void
  showError: (action: string, error: unknown) => Promise<void>
  openProjectTreeFile: (request: ProjectTreeOpenRequest, sourceWindowId?: string) => Promise<void>
  onOriginDetached: (nodeId: number) => void
}

/** ツリーの幅・開閉と分離子窓を組み立て、Appへ操作APIを公開する。 */
export function useProjectTreeWindowController(options: ProjectTreeWindowControllerOptions) {
  const projectTreeDetached = ref(options.initialPreferences.ui.projectTree.detached)
  const paneLayout = useProjectTreePaneLayout({
    initialPreferences: options.initialPreferences,
    detached: projectTreeDetached,
    showPersistenceNotice: options.showPersistenceNotice,
  })
  const detachedWindow = useDetachedProjectTreeWindow({
    detached: projectTreeDetached,
    projectTreeDisplayWidth: paneLayout.projectTreeDisplayWidth,
    busy: options.busy,
    documentLocked: options.documentLocked,
    documentOrigin: options.documentOrigin,
    mainCloseInProgress: options.mainCloseInProgress,
    showPersistenceNotice: options.showPersistenceNotice,
    showError: options.showError,
    scheduleProjectTreePreferencesSave: paneLayout.scheduleProjectTreePreferencesSave,
    openProjectTreeFile: options.openProjectTreeFile,
    onOriginDetached: options.onOriginDetached,
  })
  let disposed = false

  /** 画面の購読と子ウィンドウの状態監視を順番に開始する。 */
  async function setup(): Promise<void> {
    if (disposed) return
    paneLayout.setup()
    if (disposed) return
    await detachedWindow.setup()
  }

  /** 表示設定の保存だけを、終了調停から呼べる形で待つ。 */
  async function flush(): Promise<void> {
    await paneLayout.flush()
  }

  /** 子窓・購読・幅保存を破棄し、遅着イベントの画面反映を止める。 */
  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    const detachedDispose = detachedWindow.dispose()
    await paneLayout.dispose()
    await detachedDispose
  }

  return {
    projectTreeCollapsed: paneLayout.projectTreeCollapsed,
    projectTreeVisuallyCollapsed: paneLayout.projectTreeVisuallyCollapsed,
    projectTreeDrawerWidth: paneLayout.projectTreeDrawerWidth,
    toggleProjectTreeCollapsed: paneLayout.toggleProjectTreeCollapsed,
    projectTreeDetached: detachedWindow.projectTreeDetached,
    projectTreeResizing: paneLayout.projectTreeResizing,
    expandedProjectTreeFolderIds: detachedWindow.expandedProjectTreeFolderIds,
    projectTreeUnavailableNodeIds: detachedWindow.projectTreeUnavailableNodeIds,
    projectTreeOpenResult: detachedWindow.projectTreeOpenResult,
    projectTreeWindowDisabled: detachedWindow.projectTreeWindowDisabled,
    projectTreeMaximumWidth: paneLayout.projectTreeMaximumWidth,
    projectTreeDisplayWidth: paneLayout.projectTreeDisplayWidth,
    updateExpandedProjectTreeFolders: detachedWindow.updateExpandedProjectTreeFolders,
    updateProjectTreeUnavailableNodeIds: detachedWindow.updateProjectTreeUnavailableNodeIds,
    consumeProjectTreeOpenResult: detachedWindow.consumeProjectTreeOpenResult,
    reportProjectTreeOpenResult: detachedWindow.reportProjectTreeOpenResult,
    startProjectTreeResize: paneLayout.startProjectTreeResize,
    moveProjectTreeResize: paneLayout.moveProjectTreeResize,
    endProjectTreeResize: paneLayout.endProjectTreeResize,
    cancelProjectTreeResize: paneLayout.cancelProjectTreeResize,
    onProjectTreeResizeKeydown: paneLayout.onProjectTreeResizeKeydown,
    publishProjectTreeWindowState: detachedWindow.publishProjectTreeWindowState,
    openProjectTreeWindow: detachedWindow.openProjectTreeWindow,
    closeProjectTreeWindowForExit: detachedWindow.closeProjectTreeWindowForExit,
    restoreAfterCloseFailure: detachedWindow.restoreAfterCloseFailure,
    hasProjectTreeWindow: detachedWindow.hasProjectTreeWindow,
    requestProjectTreeDetach: detachedWindow.requestProjectTreeDetach,
    setup,
    flush,
    dispose,
  }
}
