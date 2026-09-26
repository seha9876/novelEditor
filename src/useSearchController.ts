/** 検索セッション、検索ウィンドウ、本文との検索連携をメイン画面から分離する。 */
import { watch, type Ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import {
  SEARCH_COMMAND_EVENT,
  SEARCH_STATE_EVENT,
  SearchSession,
  type SearchAction,
  type SearchCommand,
  type SearchConditions,
  type SearchField,
  type SearchSnapshot,
  type SearchStatus,
} from './searchSession'

export type SearchEditorAdapter = {
  setSearch: (conditions: SearchConditions, active: boolean) => void
  runSearch: (action: SearchAction) => void
  focus: () => void
}

type SearchWindowHost = {
  setFocus: () => Promise<void>
}

export type SearchControllerOptions = {
  editor: Ref<SearchEditorAdapter | null>
  documentLocked: Ref<boolean>
  mainCloseInProgress: Ref<boolean>
  appWindow: SearchWindowHost
  showPersistenceNotice: (text: string) => void
  showError: (action: string, error: unknown) => Promise<void>
}

/** 検索状態を配信し、遅着した子ウィンドウ操作をセッションIDで拒否する。 */
export function useSearchController(options: SearchControllerOptions) {
  const searchSession = new SearchSession()
  let searchWindow: WebviewWindow | null = null
  let searchWindowOpening = false
  let searchWindowReady = false
  let searchWindowClosing = false
  let searchStatus: SearchStatus = 'empty'
  let searchStateRevision = 0
  let searchWindowError = ''
  let searchFocus = { field: 'search' as SearchField, revision: 0 }
  let unlistenSearchCommand: (() => void) | undefined
  let setupPromise: Promise<void> | null = null
  let disposed = false

  /** 本文の検索結果と操作可否を配信する。revisionで古い配信の到着を区別する。 */
  async function publishSearchState(): Promise<void> {
    if (disposed || !searchWindowReady || !searchSession.sessionId) return
    const snapshot: SearchSnapshot = {
      sessionId: searchSession.sessionId,
      conditions: { ...searchSession.conditions },
      status: searchStatus,
      locked: options.documentLocked.value,
      documentRevision: searchSession.documentRevision,
      acknowledgedSequence: searchSession.sequence,
      revision: ++searchStateRevision,
      focus: { ...searchFocus },
      error: searchWindowError,
    }
    try {
      await emitTo('search', SEARCH_STATE_EVENT, snapshot)
    } catch (error) {
      if (!disposed && searchWindowReady) options.showPersistenceNotice(`検索画面へ結果を送れません。${String(error)}`)
    }
  }

  /** 本文が変わった場合も検索結果を更新し、開いている検索画面へ通知する。 */
  function onStatus(status: SearchStatus): void {
    searchStatus = status
    void publishSearchState()
  }

  /** 検索窓の破棄を反映する。条件は残し、通常の終了時だけ本文へフォーカスを戻す。 */
  function handleSearchWindowDestroyed(destroyedWindow: WebviewWindow): void {
    if (searchWindow !== destroyedWindow) return
    searchWindow = null
    searchWindowOpening = false
    searchWindowClosing = false
    searchWindowReady = false
    searchSession.stop()
    if (!disposed) options.editor.value?.setSearch(searchSession.conditions, false)
    if (!options.mainCloseInProgress.value && !disposed) {
      void options.appWindow.setFocus().then(() => options.editor.value?.focus()).catch((error: unknown) => {
        options.showPersistenceNotice(`本文へフォーカスを戻せません。${String(error)}`)
      })
    }
  }

  /** メイン側で破棄することで、閉じる直前の入力を確定してから検索窓を終了する。 */
  async function close(): Promise<void> {
    if (!searchWindow) return
    const closingWindow = searchWindow
    searchWindowClosing = true
    try {
      await closingWindow.destroy()
      handleSearchWindowDestroyed(closingWindow)
    } catch (error) {
      searchWindowError = `検索画面を閉じられません。もう一度操作してください。${String(error)}`
      await publishSearchState()
      throw error
    } finally {
      searchWindowClosing = false
    }
  }

  /** 独立した非モーダル検索窓を1つだけ開き、既存の窓では指定入力へフォーカスする。 */
  async function open(field: SearchField): Promise<void> {
    if (disposed || options.documentLocked.value || options.mainCloseInProgress.value || searchWindowClosing) return
    searchFocus = { field, revision: searchFocus.revision + 1 }
    if (searchWindowOpening) return
    if (searchWindow) {
      try {
        await searchWindow.unminimize()
        await searchWindow.setFocus()
        await publishSearchState()
      } catch (error) {
        await options.showError('検索画面を開く操作', error)
      }
      return
    }
    searchWindowOpening = true
    searchWindowError = ''
    const sessionId = crypto.randomUUID()
    searchSession.start(sessionId)
    try {
      const createdWindow = new WebviewWindow('search', {
        url: `search.html?session=${encodeURIComponent(sessionId)}`,
        title: '検索・置換',
        parent: 'main',
        center: true,
        width: 640,
        height: 380,
        minWidth: 480,
        minHeight: 340,
        resizable: true,
        decorations: true,
        dragDropEnabled: false,
      })
      searchWindow = createdWindow
      void createdWindow.once('tauri://destroyed', () => handleSearchWindowDestroyed(createdWindow))
      void createdWindow.once('tauri://created', () => { searchWindowOpening = false })
      void createdWindow.once('tauri://error', (event) => {
        if (disposed) return
        handleSearchWindowDestroyed(createdWindow)
        void options.showError('検索画面を開く操作', event.payload)
      })
    } catch (error) {
      searchWindowOpening = false
      searchSession.stop()
      await options.showError('検索画面を開く操作', error)
    }
  }

  /** 本文側のF3は条件があればそのまま検索し、未指定なら検索画面を開く。 */
  function onNavigate(action: SearchAction): void {
    if (disposed || options.documentLocked.value || options.mainCloseInProgress.value) return
    if (!searchSession.conditions.search) {
      void open('search')
      return
    }
    options.editor.value?.runSearch(action)
  }

  /** 入力と操作を同じ要求として処理し、操作時の条件を非同期の到着順へ依存させない。 */
  function handleCommand(command: SearchCommand): void {
    if (disposed || !searchWindow || searchWindowClosing || command.sessionId !== searchSession.sessionId) return
    searchWindowError = ''
    if (command.type === 'ready') {
      searchWindowReady = true
      options.editor.value?.setSearch(searchSession.conditions, true)
    } else {
      const result = searchSession.receive(command)
      if (!result.accepted) return
      options.editor.value?.setSearch(searchSession.conditions, true)
      if (result.action) options.editor.value?.runSearch(result.action)
      if (command.type === 'close') {
        void close().catch((error: unknown) => options.showError('検索画面を閉じる操作', error))
        return
      }
    }
    void publishSearchState()
  }

  /** 検索コマンドのイベント購読を開始する。 */
  async function setup(): Promise<void> {
    if (disposed) return
    if (setupPromise) return setupPromise
    if (unlistenSearchCommand) return
    const setupRun = (async () => {
      const lateUnlisten = await listen<SearchCommand>(SEARCH_COMMAND_EVENT, (event) => {
        handleCommand(event.payload)
      })
      if (disposed) {
        lateUnlisten()
        return
      }
      unlistenSearchCommand = lateUnlisten
    })()
    setupPromise = setupRun
    try {
      await setupRun
    } finally {
      if (setupPromise === setupRun) setupPromise = null
    }
  }

  /** 終了前に検索窓を閉じ、購読と状態監視を解除する。 */
  async function dispose(): Promise<void> {
    disposed = true
    unlistenSearchCommand?.()
    unlistenSearchCommand = undefined
    stopDocumentLockWatch()
    searchWindowReady = false
    try {
      await close()
    } catch {
      // 画面破棄時は呼び出し元へ検索窓の終了失敗を伝播させない。
    }
  }

  const stopDocumentLockWatch = watch(options.documentLocked, () => {
    searchSession.setLocked(options.documentLocked.value)
    void publishSearchState()
  }, { flush: 'sync' })

  return {
    open,
    close,
    onStatus,
    onNavigate,
    setup,
    dispose,
  }
}
