/** プロジェクトツリーの幅と分離ウィンドウをメイン画面から分離する。 */
import { computed, ref, watch, type Ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { saveProjectTreePreferences } from './appPreferences'
import type { ApplicationPreferencesV1 } from './appPreferenceSchema'
import {
  PROJECT_TREE_WINDOW_COMMAND_EVENT,
  PROJECT_TREE_WINDOW_STATE_EVENT,
  type ProjectTreeOpenRequest,
  type ProjectTreeOpenResult,
  type ProjectTreeWindowCommand,
  type ProjectTreeWindowState,
} from './projectTreeWindow'

export type ProjectTreeDocumentOrigin = { nodeId: number; projectId: number }

export type ProjectTreeWindowControllerOptions = {
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

type ProjectTreeWindowCreation = {
  window: WebviewWindow | null
  resolve: (opened: boolean) => void
  settled: boolean
}

/** ツリーの表示設定と子ウィンドウのイベントを接続する。 */
export function useProjectTreeWindowController(options: ProjectTreeWindowControllerOptions) {
  const projectTreeWidth = ref(options.initialPreferences.ui.projectTree.width)
  const projectTreeDetached = ref(options.initialPreferences.ui.projectTree.detached)
  const projectTreeResizing = ref(false)
  const mainViewportWidth = ref(window.innerWidth)
  const expandedProjectTreeFolderIds = ref<number[]>([])
  const projectTreeUnavailableNodeIds = ref<number[]>([])
  const projectTreeOpenResult = ref<ProjectTreeOpenResult | null>(null)
  const projectTreeWindowDisabled = computed(() => options.busy.value || options.mainCloseInProgress.value)
  const projectTreeMaximumWidth = computed(() => Math.max(220, Math.min(480, mainViewportWidth.value - 320)))
  const projectTreeDisplayWidth = computed(() => Math.min(projectTreeWidth.value, projectTreeMaximumWidth.value))

  let unlistenProjectTreeCommand: (() => void) | undefined
  let unlistenViewportResize: (() => void) | undefined
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
  let projectTreeSaveTimer: ReturnType<typeof setTimeout> | undefined
  let projectTreeSavePromise = Promise.resolve()
  let projectTreeResizeStart: { pointerId: number; startX: number; startWidth: number } | null = null
  let stopProjectTreeStateWatch: (() => void) | undefined
  let setupPromise: Promise<void> | null = null
  let disposed = false

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

  /** 不正な値や重複 ID を除き、展開中フォルダーの同期値を正規化する。 */
  function normalizeProjectTreeNodeIds(nodeIds: number[]): number[] {
    return [...new Set(nodeIds.filter((nodeId) => Number.isSafeInteger(nodeId) && nodeId > 0))]
  }

  /** 最新のツリー幅と分離状態を設定Storeへ直列保存する。 */
  function persistProjectTreePreferences(): Promise<void> {
    projectTreeSavePromise = projectTreeSavePromise.catch(() => undefined).then(async () => {
      try {
        await saveProjectTreePreferences({ width: projectTreeWidth.value, detached: projectTreeDetached.value })
      } catch (error) {
        if (!disposed) options.showPersistenceNotice(`プロジェクトツリーの表示設定を保存できません。${String(error)}`)
      }
    })
    return projectTreeSavePromise
  }

  /** 連続した幅変更をまとめ、最後の位置だけを保存する。 */
  function scheduleProjectTreePreferencesSave(): void {
    if (disposed) return
    if (projectTreeSaveTimer) clearTimeout(projectTreeSaveTimer)
    projectTreeSaveTimer = setTimeout(() => {
      projectTreeSaveTimer = undefined
      void persistProjectTreePreferences()
    }, 250)
  }

  /** 終了前に遅延中の表示設定保存を完了させる。 */
  async function flush(): Promise<void> {
    if (projectTreeSaveTimer) {
      clearTimeout(projectTreeSaveTimer)
      projectTreeSaveTimer = undefined
      await persistProjectTreePreferences()
    } else {
      await projectTreeSavePromise
    }
  }

  /** 表示上限を適用してツリー幅を更新し、必要な操作のときだけ設定保存を予約する。 */
  function setProjectTreeWidth(width: number, persist = true): void {
    projectTreeWidth.value = Math.max(220, Math.min(projectTreeMaximumWidth.value, Math.round(width)))
    if (persist) scheduleProjectTreePreferencesSave()
  }

  /** メインウィンドウの実幅を取り直し、本文の最小幅を保つ表示上限を更新する。 */
  function updateMainViewportWidth(): void {
    mainViewportWidth.value = window.innerWidth
  }

  /** メインに表示中のツリーから受け取った展開状態を分離時の引き継ぎ値にする。 */
  function updateExpandedProjectTreeFolders(nodeIds: number[]): void {
    expandedProjectTreeFolderIds.value = normalizeProjectTreeNodeIds(nodeIds)
  }

  /** 参照切れノードの状態を保持し、ドック後のツリーへ引き継ぐ。 */
  function updateProjectTreeUnavailableNodeIds(nodeIds: number[], publishChild = true): boolean {
    const normalized = normalizeProjectTreeNodeIds(nodeIds)
    const current = projectTreeUnavailableNodeIds.value
    if (current.length === normalized.length && current.every((nodeId, index) => nodeId === normalized[index])) return false
    projectTreeUnavailableNodeIds.value = normalized
    if (publishChild && projectTreeDetached.value) void publishProjectTreeWindowState()
    return true
  }

  /** 開く結果を一時イベントとして消費し、古い失敗状態の再適用を防ぐ。 */
  function consumeProjectTreeOpenResult(requestId: string): void {
    if (projectTreeOpenResult.value?.requestId !== requestId) return
    projectTreeOpenResult.value = null
    if (projectTreeDetached.value) void publishProjectTreeWindowState()
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

  /** 保留中の幅保存をドラッグ終了時へ集約し、開始幅とポインター捕捉を設定する。 */
  function startProjectTreeResize(event: PointerEvent): void {
    if (event.button !== 0) return
    if (projectTreeSaveTimer !== undefined) {
      clearTimeout(projectTreeSaveTimer)
      projectTreeSaveTimer = undefined
    }
    event.preventDefault()
    projectTreeResizeStart = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: projectTreeDisplayWidth.value,
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    projectTreeResizing.value = true
  }

  /** ポインター移動量をドック幅へ反映する。 */
  function moveProjectTreeResize(event: PointerEvent): void {
    if (projectTreeResizeStart?.pointerId !== event.pointerId) return
    setProjectTreeWidth(projectTreeResizeStart.startWidth + event.clientX - projectTreeResizeStart.startX, false)
  }

  /** ドラッグ終了・キャンセル・キャプチャ喪失を確定し、幅を一度だけ保存予約する。 */
  function endProjectTreeResize(event: PointerEvent): void {
    if (projectTreeResizeStart?.pointerId !== event.pointerId) return
    projectTreeResizeStart = null
    projectTreeResizing.value = false
    scheduleProjectTreePreferencesSave()
  }

  /** 左右キーと Home/End でツリー幅を調整する。 */
  function onProjectTreeResizeKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft') setProjectTreeWidth(projectTreeDisplayWidth.value - 16)
    else if (event.key === 'ArrowRight') setProjectTreeWidth(projectTreeDisplayWidth.value + 16)
    else if (event.key === 'Home') setProjectTreeWidth(220)
    else if (event.key === 'End') setProjectTreeWidth(projectTreeMaximumWidth.value)
    else return
    event.preventDefault()
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
    if (disposed || !command || command.windowId !== projectTreeWindowId || !projectTreeWindow || !projectTreeDetached.value) return
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

  /** 分離ウィンドウの生成イベントを登録し、成功・失敗を呼び出し元へ返す。 */
  function createProjectTreeWindow(): Promise<boolean> {
    projectTreeWindowId = crypto.randomUUID()
    projectTreeWindowStateRevision = 0
    const windowId = projectTreeWindowId
    return new Promise((resolve) => {
      const creation: ProjectTreeWindowCreation = {
        window: null,
        resolve,
        settled: false,
      }
      projectTreeWindowCreation = creation
      try {
        const createdWindow = new WebviewWindow('project-tree', {
          url: `project-tree.html?windowId=${encodeURIComponent(windowId)}`,
          title: 'プロジェクトツリー',
          parent: 'main',
          width: Math.max(320, projectTreeDisplayWidth.value + 40),
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
          projectTreeDetached.value = true
          scheduleProjectTreePreferencesSave()
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
            projectTreeDetached.value = false
            scheduleProjectTreePreferencesSave()
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
        projectTreeDetached.value = false
        scheduleProjectTreePreferencesSave()
        options.showPersistenceNotice(`分離ウィンドウを作成できないため、ツリーをメイン画面に表示します。${String(error)}`)
        settleProjectTreeWindowCreation(creation, false)
        projectTreeWindowCreation = projectTreeWindowCreation === creation ? null : projectTreeWindowCreation
      }
    })
  }

  /** ボタンまたは子ウィンドウの×から分離窓を閉じ、展開状態を保ってドックへ戻す。 */
  async function dockProjectTreeWindow(): Promise<void> {
    if (disposed) return
    if (!projectTreeDetached.value && !projectTreeWindow) return
    projectTreeDetached.value = false
    scheduleProjectTreePreferencesSave()
    const closingWindow = projectTreeWindow
    if (!closingWindow) return

    projectTreeWindowClosingForDock = true
    const closing = destroyProjectTreeWindow(closingWindow)
    projectTreeWindowClosePromise = closing
    try {
      await closing
    } catch (error) {
      if (!disposed) {
        projectTreeDetached.value = projectTreeWindow === closingWindow
        projectTreeWindowClosingForDock = false
        scheduleProjectTreePreferencesSave()
        await options.showError('プロジェクトツリーを戻す操作', error)
      }
    } finally {
      if (projectTreeWindow === closingWindow && !projectTreeDetached.value) {
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
    if (projectTreeDetached.value) {
      projectTreeDetached.value = false
      scheduleProjectTreePreferencesSave()
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

  /** 画面の購読と状態監視を開始する。初期の分離窓生成は復元処理後に呼び出し元が行う。 */
  async function setup(): Promise<void> {
    if (disposed) return
    if (setupPromise) return setupPromise
    const setupRun = (async () => {
      if (disposed) return
      if (!unlistenViewportResize) {
        window.addEventListener('resize', updateMainViewportWidth)
        unlistenViewportResize = () => window.removeEventListener('resize', updateMainViewportWidth)
      }
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

  /** 表示設定の保存を待ち、購読と子ウィンドウを破棄する。 */
  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    if (projectTreeWindowCreation) {
      settleProjectTreeWindowCreation(projectTreeWindowCreation, false)
      projectTreeWindowCreation = null
    }
    unlistenProjectTreeCommand?.()
    unlistenProjectTreeCommand = undefined
    unlistenViewportResize?.()
    unlistenViewportResize = undefined
    stopProjectTreeStateWatch?.()
    stopProjectTreeStateWatch = undefined
    await flush()
    if (projectTreeSaveTimer) clearTimeout(projectTreeSaveTimer)
    projectTreeSaveTimer = undefined
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
    projectTreeDetached,
    projectTreeResizing,
    expandedProjectTreeFolderIds,
    projectTreeUnavailableNodeIds,
    projectTreeOpenResult,
    projectTreeWindowDisabled,
    projectTreeMaximumWidth,
    projectTreeDisplayWidth,
    updateExpandedProjectTreeFolders,
    updateProjectTreeUnavailableNodeIds,
    consumeProjectTreeOpenResult,
    reportProjectTreeOpenResult,
    startProjectTreeResize,
    moveProjectTreeResize,
    endProjectTreeResize,
    onProjectTreeResizeKeydown,
    publishProjectTreeWindowState,
    openProjectTreeWindow,
    closeProjectTreeWindowForExit,
    restoreAfterCloseFailure,
    hasProjectTreeWindow,
    requestProjectTreeDetach,
    setup,
    flush,
    dispose,
  }
}
