/** 分離プロジェクトツリーの子窓、イベント同期、開閉競合をメイン画面から分離する。 */
import { computed, ref, watch, type Ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import {
  PROJECT_TREE_WINDOW_COMMAND_EVENT,
  PROJECT_TREE_WINDOW_STATE_EVENT,
  type ProjectTreeOpenRequest,
  type ProjectTreeOpenResult,
  type ProjectTreeWindowCommand,
  type ProjectTreeWindowState,
} from './projectTreeWindow'

export type DetachedProjectTreeDocumentOrigin = { nodeId: number; projectId: number }

type DetachedProjectTreeWindowOptions = {
  detached: Ref<boolean>
  projectTreeDisplayWidth: Ref<number>
  busy: Ref<boolean>
  documentLocked: Ref<boolean>
  documentOrigin: Ref<DetachedProjectTreeDocumentOrigin | null>
  mainCloseInProgress: Ref<boolean>
  showPersistenceNotice: (text: string) => void
  showError: (action: string, error: unknown) => Promise<void>
  scheduleProjectTreePreferencesSave: () => void
  openProjectTreeFile: (request: ProjectTreeOpenRequest, sourceWindowId?: string) => Promise<void>
  onOriginDetached: (nodeId: number) => void
}

type ProjectTreeWindowCreation = {
  window: WebviewWindow | null
  resolve: (opened: boolean) => void
  settled: boolean
}

/** 分離ツリーの表示状態と子窓ライフサイクルを所有する。 */
export function useDetachedProjectTreeWindow(options: DetachedProjectTreeWindowOptions) {
  const expandedProjectTreeFolderIds = ref<number[]>([])
  const projectTreeUnavailableNodeIds = ref<number[]>([])
  const projectTreeOpenResult = ref<ProjectTreeOpenResult | null>(null)
  const projectTreeWindowDisabled = computed(() => options.busy.value || options.mainCloseInProgress.value)

  let unlistenProjectTreeCommand: (() => void) | undefined
  let projectTreeWindow: WebviewWindow | null = null
  let projectTreeWindowId = ''
  let projectTreeWindowOpeningPromise: Promise<boolean> | null = null
  let projectTreeWindowCreation: ProjectTreeWindowCreation | null = null
  let projectTreeWindowDestroyTarget: WebviewWindow | null = null
  let projectTreeWindowDestroyPromise: Promise<void> | null = null
  let projectTreeWindowClosePromise: Promise<void> | null = null
  let projectTreeWindowClosingForDock = false
  let projectTreeWindowClosingForExit = false
  let projectTreeWindowStateRevision = 0
  let stopProjectTreeStateWatch: (() => void) | undefined
  let setupPromise: Promise<void> | null = null
  let disposed = false

  /** 不正な値や重複 ID を除き、展開中フォルダーの同期値を正規化する。 */
  function normalizeProjectTreeNodeIds(nodeIds: number[]): number[] {
    return [...new Set(nodeIds.filter((nodeId) => Number.isSafeInteger(nodeId) && nodeId > 0))]
  }

  /** メインに表示中のツリーから受け取った展開状態を分離時の引き継ぎ値にする。 */
  function updateExpandedProjectTreeFolders(nodeIds: number[]): void {
    expandedProjectTreeFolderIds.value = normalizeProjectTreeNodeIds(nodeIds)
  }

  /** 分離ウィンドウの生成結果を一度だけ確定し、遅着イベントによる二重解決を防ぐ。 */
  function settleProjectTreeWindowCreation(creation: ProjectTreeWindowCreation, opened: boolean): void {
    if (creation.settled) return
    creation.settled = true
    creation.resolve(opened)
  }

  /** 同じWebviewWindowへのdestroyを一度だけ開始し、dock・終了・破棄競合で共有する。 */
  function destroyProjectTreeWindow(target: WebviewWindow): Promise<void> {
    if (projectTreeWindowDestroyTarget === target && projectTreeWindowDestroyPromise) {
      return projectTreeWindowDestroyPromise
    }
    projectTreeWindowDestroyTarget = target
    const destroyPromise = Promise.resolve()
      .then(() => target.destroy())
      .then(() => undefined, (error: unknown) => {
        if (projectTreeWindowDestroyTarget === target) {
          projectTreeWindowDestroyTarget = null
          projectTreeWindowDestroyPromise = null
        }
        throw error
      })
    projectTreeWindowDestroyPromise = destroyPromise
    return destroyPromise
  }

  /** 参照切れノードの状態を保持し、ドック後のツリーへ引き継ぐ。 */
  function updateProjectTreeUnavailableNodeIds(nodeIds: number[], publishChild = true): boolean {
    const normalized = normalizeProjectTreeNodeIds(nodeIds)
    const current = projectTreeUnavailableNodeIds.value
    if (current.length === normalized.length && current.every((nodeId, index) => nodeId === normalized[index])) return false
    projectTreeUnavailableNodeIds.value = normalized
    if (publishChild && options.detached.value) void publishProjectTreeWindowState()
    return true
  }

  /** 開く結果を一時イベントとして消費し、古い失敗状態の再適用を防ぐ。 */
  function consumeProjectTreeOpenResult(requestId: string): void {
    if (projectTreeOpenResult.value?.requestId !== requestId) return
    projectTreeOpenResult.value = null
    if (options.detached.value) void publishProjectTreeWindowState()
  }

  /** 開く操作の成否を元のツリーへ返し、参照切れ表示と既存エラー通知を維持する。 */
  function reportProjectTreeOpenResult(result: ProjectTreeOpenResult, sourceWindowId?: string): void {
    const unavailable = new Set(projectTreeUnavailableNodeIds.value)
    if (result.error && result.unavailable) unavailable.add(result.nodeId)
    else if (!result.error) unavailable.delete(result.nodeId)
    updateProjectTreeUnavailableNodeIds([...unavailable], false)
    projectTreeOpenResult.value = result
    if (sourceWindowId && sourceWindowId === projectTreeWindowId && projectTreeWindow) {
      const requestWindowId = sourceWindowId
      void publishProjectTreeWindowState(result).then((published) => {
        if (disposed || published || requestWindowId !== projectTreeWindowId || !projectTreeWindow
          || projectTreeWindowClosingForDock || projectTreeWindowClosingForExit) return
        if (projectTreeOpenResult.value?.requestId === result.requestId) projectTreeOpenResult.value = null
        const detail = result.error
          ? `ファイル操作の結果を分離ツリーへ伝えられませんでした。${result.error}`
          : 'ファイル操作の結果を分離ツリーへ伝えられませんでした。'
        options.showPersistenceNotice(`${detail} メイン画面へ戻します。`)
        void dockProjectTreeWindow()
      })
    }
  }

  /** メイン画面の状態とツリーの展開状態を、識別子付きで分離ウィンドウへ送る。 */
  async function publishProjectTreeWindowState(openResult = projectTreeOpenResult.value): Promise<boolean> {
    if (disposed) return false
    const windowId = projectTreeWindowId
    if (!windowId || !projectTreeWindow || projectTreeWindowClosingForDock || projectTreeWindowClosingForExit) return false
    const state: ProjectTreeWindowState = {
      windowId,
      revision: ++projectTreeWindowStateRevision,
      disabled: projectTreeWindowDisabled.value,
      documentOrigin: options.documentOrigin.value ? { ...options.documentOrigin.value } : null,
      expandedFolderIds: [...expandedProjectTreeFolderIds.value],
      unavailableNodeIds: [...projectTreeUnavailableNodeIds.value],
      ...(openResult ? { openResult } : {}),
    }
    try {
      await emitTo('project-tree', PROJECT_TREE_WINDOW_STATE_EVENT, state)
      return !disposed && windowId === projectTreeWindowId
    } catch (error) {
      if (!disposed && windowId === projectTreeWindowId) {
        options.showPersistenceNotice(`分離したプロジェクトツリーへ状態を送れません。${String(error)}`)
      }
      return false
    }
  }

  /** 分離中の操作をウィンドウIDで検査し、現在の子ウィンドウ要求だけを処理する。 */
  function handleProjectTreeWindowCommand(command: ProjectTreeWindowCommand): void {
    if (disposed || !command || command.windowId !== projectTreeWindowId || !projectTreeWindow || !options.detached.value) return
    if (command.type === 'ready') {
      void publishProjectTreeWindowState()
    } else if (command.type === 'dock') {
      if (command.expandedFolderIds) expandedProjectTreeFolderIds.value = normalizeProjectTreeNodeIds(command.expandedFolderIds)
      if (command.unavailableNodeIds) updateProjectTreeUnavailableNodeIds(command.unavailableNodeIds, false)
      void dockProjectTreeWindow()
    } else if (command.type === 'expanded-change') {
      expandedProjectTreeFolderIds.value = normalizeProjectTreeNodeIds(command.nodeIds)
      void publishProjectTreeWindowState()
    } else if (command.type === 'unavailable-change') {
      if (updateProjectTreeUnavailableNodeIds(command.nodeIds, false)) void publishProjectTreeWindowState()
    } else if (command.type === 'origin-detached') {
      options.onOriginDetached(command.nodeId)
    } else if (command.type === 'open-file') {
      void options.openProjectTreeFile(command.request, command.windowId)
    } else if (command.type === 'open-result-applied') {
      consumeProjectTreeOpenResult(command.requestId)
    }
  }

  /** 分離ウィンドウの生成イベントを登録し、成功・失敗を呼び出し元へ返す。 */
  function createProjectTreeWindow(): Promise<boolean> {
    projectTreeWindowId = crypto.randomUUID()
    projectTreeWindowStateRevision = 0
    const windowId = projectTreeWindowId
    return new Promise((resolve) => {
      const creation: ProjectTreeWindowCreation = { window: null, resolve, settled: false }
      projectTreeWindowCreation = creation
      try {
        const createdWindow = new WebviewWindow('project-tree', {
          url: `project-tree.html?windowId=${encodeURIComponent(windowId)}`,
          title: 'プロジェクトツリー',
          parent: 'main',
          width: Math.max(320, options.projectTreeDisplayWidth.value + 40),
          height: 720,
          minWidth: 260,
          minHeight: 360,
          resizable: true,
          decorations: true,
          dragDropEnabled: true,
        })
        creation.window = createdWindow
        projectTreeWindow = createdWindow
        void createdWindow.once('tauri://created', () => {
          if (disposed) {
            if (projectTreeWindow === createdWindow) {
              projectTreeWindow = null
              if (projectTreeWindowId === windowId) projectTreeWindowId = ''
            }
            settleProjectTreeWindowCreation(creation, false)
            projectTreeWindowCreation = projectTreeWindowCreation === creation ? null : projectTreeWindowCreation
            void destroyProjectTreeWindow(createdWindow).catch(() => {})
            return
          }
          if (creation.settled) return
          if (projectTreeWindowId !== windowId || projectTreeWindow !== createdWindow) {
            settleProjectTreeWindowCreation(creation, false)
            projectTreeWindowCreation = projectTreeWindowCreation === creation ? null : projectTreeWindowCreation
            return
          }
          options.detached.value = true
          options.scheduleProjectTreePreferencesSave()
          void publishProjectTreeWindowState()
          settleProjectTreeWindowCreation(creation, true)
        })
        void createdWindow.once('tauri://error', (event) => {
          if (disposed) {
            if (projectTreeWindow === createdWindow) {
              projectTreeWindow = null
              if (projectTreeWindowId === windowId) projectTreeWindowId = ''
            }
            settleProjectTreeWindowCreation(creation, false)
            projectTreeWindowCreation = projectTreeWindowCreation === creation ? null : projectTreeWindowCreation
            return
          }
          if (creation.settled) return
          if (projectTreeWindowId === windowId) {
            projectTreeWindow = null
            projectTreeWindowId = ''
            options.detached.value = false
            options.scheduleProjectTreePreferencesSave()
            options.showPersistenceNotice(`分離ウィンドウを作成できないため、ツリーをメイン画面に表示します。${String(event.payload)}`)
          }
          settleProjectTreeWindowCreation(creation, false)
          projectTreeWindowCreation = projectTreeWindowCreation === creation ? null : projectTreeWindowCreation
        })
        void createdWindow.once('tauri://destroyed', () => {
          if (disposed) {
            if (projectTreeWindow === createdWindow) {
              projectTreeWindow = null
              if (projectTreeWindowId === windowId) projectTreeWindowId = ''
            }
            settleProjectTreeWindowCreation(creation, false)
            projectTreeWindowCreation = projectTreeWindowCreation === creation ? null : projectTreeWindowCreation
            return
          }
          if (!creation.settled) {
            handleProjectTreeWindowDestroyed(createdWindow)
            settleProjectTreeWindowCreation(creation, false)
          } else {
            handleProjectTreeWindowDestroyed(createdWindow)
          }
          projectTreeWindowCreation = projectTreeWindowCreation === creation ? null : projectTreeWindowCreation
        })
      } catch (error) {
        if (disposed) {
          settleProjectTreeWindowCreation(creation, false)
          projectTreeWindowCreation = projectTreeWindowCreation === creation ? null : projectTreeWindowCreation
          if (creation.window) void destroyProjectTreeWindow(creation.window).catch(() => {})
          return
        }
        if (creation.window) void destroyProjectTreeWindow(creation.window).catch(() => {})
        projectTreeWindow = null
        projectTreeWindowId = ''
        options.detached.value = false
        options.scheduleProjectTreePreferencesSave()
        options.showPersistenceNotice(`分離ウィンドウを作成できないため、ツリーをメイン画面に表示します。${String(error)}`)
        settleProjectTreeWindowCreation(creation, false)
        projectTreeWindowCreation = projectTreeWindowCreation === creation ? null : projectTreeWindowCreation
      }
    })
  }

  /** 分離ウィンドウを一つだけ作成し、生成失敗時はメイン画面表示へ戻す。 */
  async function openProjectTreeWindow(): Promise<boolean> {
    if (disposed) return false
    if (projectTreeWindowClosePromise) {
      try {
        await projectTreeWindowClosePromise
      } catch {
        // 破棄に失敗した場合は、残っている子ウィンドウを前面へ戻す。
      }
    }
    if (disposed) return false
    if (projectTreeWindowOpeningPromise) return projectTreeWindowOpeningPromise
    if (projectTreeWindow) {
      try {
        await projectTreeWindow.setFocus()
        if (disposed) return false
      } catch (error) {
        if (!disposed) options.showPersistenceNotice(`分離したプロジェクトツリーへ切り替えられません。${String(error)}`)
        else return false
      }
      return true
    }
    if (disposed) return false

    const opening = createProjectTreeWindow()
    projectTreeWindowOpeningPromise = opening
    try {
      return await opening
    } finally {
      if (projectTreeWindowOpeningPromise === opening) projectTreeWindowOpeningPromise = null
    }
  }

  /** ボタンまたは子ウィンドウの×から分離窓を閉じ、展開状態を保ってドックへ戻す。 */
  async function dockProjectTreeWindow(): Promise<void> {
    if (disposed) return
    if (!options.detached.value && !projectTreeWindow) return
    options.detached.value = false
    options.scheduleProjectTreePreferencesSave()
    const closingWindow = projectTreeWindow
    if (!closingWindow) return

    projectTreeWindowClosingForDock = true
    const closing = destroyProjectTreeWindow(closingWindow)
    projectTreeWindowClosePromise = closing
    try {
      await closing
    } catch (error) {
      if (!disposed) {
        options.detached.value = projectTreeWindow === closingWindow
        projectTreeWindowClosingForDock = false
        options.scheduleProjectTreePreferencesSave()
        await options.showError('プロジェクトツリーを戻す操作', error)
      }
    } finally {
      if (projectTreeWindow === closingWindow && !options.detached.value) {
        projectTreeWindow = null
        projectTreeWindowId = ''
        projectTreeWindowClosingForDock = false
      }
      projectTreeWindowClosePromise = null
    }
  }

  /** 予期しない子ウィンドウ終了をドッキング扱いにし、終了処理中は設定を維持する。 */
  function handleProjectTreeWindowDestroyed(destroyedWindow: WebviewWindow): void {
    if (projectTreeWindow !== destroyedWindow) return
    projectTreeWindow = null
    projectTreeWindowId = ''
    if (disposed) return
    if (projectTreeWindowClosingForDock) {
      projectTreeWindowClosingForDock = false
      return
    }
    if (projectTreeWindowClosingForExit) return
    if (options.detached.value) {
      options.detached.value = false
      options.scheduleProjectTreePreferencesSave()
      options.showPersistenceNotice('分離したプロジェクトツリーが閉じたため、メイン画面へ戻しました。')
    }
  }

  /** メイン画面の終了時に子窓も閉じ、分離設定は次回起動用に保持する。 */
  async function closeProjectTreeWindowForExit(): Promise<void> {
    if (disposed) return
    if (projectTreeWindowOpeningPromise) await projectTreeWindowOpeningPromise
    if (disposed) return
    const closingWindow = projectTreeWindow
    if (!closingWindow) return
    projectTreeWindowClosingForExit = true
    try {
      await destroyProjectTreeWindow(closingWindow)
      if (projectTreeWindow === closingWindow) {
        projectTreeWindow = null
        projectTreeWindowId = ''
      }
    } catch (error) {
      if (!disposed) projectTreeWindowClosingForExit = false
      throw error
    }
  }

  /** 終了要求が取り消された場合に子ウィンドウの終了フラグを解除し、再利用可能に戻す。 */
  function restoreAfterCloseFailure(): void {
    projectTreeWindowClosingForExit = false
  }

  /** 子ウィンドウが残っているかを終了失敗後の再表示判定へ返す。 */
  function hasProjectTreeWindow(): boolean {
    return projectTreeWindow !== null
  }

  /** 分離設定を復元する起動時とボタン操作の両方で、作成失敗を画面内通知する。 */
  async function requestProjectTreeDetach(): Promise<void> {
    if (disposed) return
    await openProjectTreeWindow()
  }

  /** 画面のイベント購読と状態監視を開始する。 */
  async function setup(): Promise<void> {
    if (disposed) return
    if (setupPromise) return setupPromise
    const setupRun = (async () => {
      if (disposed) return
      if (!unlistenProjectTreeCommand) {
        const lateUnlisten = await listen<ProjectTreeWindowCommand>(PROJECT_TREE_WINDOW_COMMAND_EVENT, (event) => {
          handleProjectTreeWindowCommand(event.payload)
        })
        if (disposed) {
          lateUnlisten()
          return
        }
        unlistenProjectTreeCommand = lateUnlisten
      }
      if (disposed) return
      stopProjectTreeStateWatch ??= watch(
        [options.busy, options.documentLocked, options.documentOrigin, options.mainCloseInProgress],
        () => { void publishProjectTreeWindowState() },
        { deep: true },
      )
    })()
    setupPromise = setupRun
    try {
      await setupRun
    } finally {
      if (setupPromise === setupRun) setupPromise = null
    }
  }

  /** 購読と子ウィンドウを破棄し、生成中Promiseも必ず失敗で完了させる。 */
  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    if (projectTreeWindowCreation) {
      settleProjectTreeWindowCreation(projectTreeWindowCreation, false)
      projectTreeWindowCreation = null
    }
    unlistenProjectTreeCommand?.()
    unlistenProjectTreeCommand = undefined
    stopProjectTreeStateWatch?.()
    stopProjectTreeStateWatch = undefined
    const closingWindow = projectTreeWindow
    if (closingWindow) {
      projectTreeWindowClosingForExit = true
      try {
        await destroyProjectTreeWindow(closingWindow)
        if (projectTreeWindow === closingWindow) {
          projectTreeWindow = null
          projectTreeWindowId = ''
        }
      } catch {
        // 画面破棄時は子ウィンドウの終了失敗を呼び出し元へ伝播させない。
      }
    }
  }

  return {
    dockProjectTreeWindow,
    projectTreeDetached: options.detached,
    expandedProjectTreeFolderIds,
    projectTreeUnavailableNodeIds,
    projectTreeOpenResult,
    projectTreeWindowDisabled,
    updateExpandedProjectTreeFolders,
    updateProjectTreeUnavailableNodeIds,
    consumeProjectTreeOpenResult,
    reportProjectTreeOpenResult,
    publishProjectTreeWindowState,
    openProjectTreeWindow,
    closeProjectTreeWindowForExit,
    restoreAfterCloseFailure,
    hasProjectTreeWindow,
    requestProjectTreeDetach,
    setup,
    dispose,
  }
}
