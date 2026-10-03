/** 設定子窓の生成、イベント購読、状態配信をメイン画面から分離する。 */
import { ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { createFrameTask } from './frameTask'
import {
  SETTINGS_COLOR_EVENT, SETTINGS_INPUT_ACK_EVENT, SETTINGS_FLUSH_INPUTS_EVENT,
  SETTINGS_COMMAND_EVENT,
  SETTINGS_ERROR_EVENT,
  SETTINGS_STATE_EVENT,
  type SettingsCommand,
  type SettingsSnapshot,
  type SettingsColorState,
} from './settingsSession'

type SettingsSnapshotPayload = Omit<SettingsSnapshot, 'revision'>

type SettingsWindowBridgeOptions = {
  getSnapshot: () => SettingsSnapshotPayload
  onCommand: (command: SettingsCommand) => Promise<void>
  showError: (action: string, error: unknown) => Promise<void>
  onDestroyed: (destroyedWindow: WebviewWindow) => void
}

/** 設定イベントと設定ウィンドウのライフサイクルを所有する。 */
export function useSettingsWindowBridge(options: SettingsWindowBridgeOptions) {
  const settingsWindowOpen = ref(false)
  let settingsWindow: WebviewWindow | null = null
  let settingsWindowOpening = false
  let unlistenSettingsCommand: (() => void) | undefined
  let setupPromise: Promise<void> | null = null
  let disposed = false
  let settingsStateRevision = 0
  let pendingColor: Omit<SettingsColorState, 'revision'> | null = null
  let sendingColor: Promise<void> | null = null
  let lastColor = ''
  const flushRequests = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const colorFrame = createFrameTask(() => { void flushColorState() })

  /** 軽量返信を直列化し、通信待ちの中間色は最新値へまとめる。 */
  async function flushColorState(): Promise<void> {
    if (sendingColor) return sendingColor
    const run = (async () => {
      while (pendingColor && !disposed) {
        const next = pendingColor; pendingColor = null
        const signature = JSON.stringify(next)
        if (signature === lastColor) continue
        try {
          await emitTo('settings', SETTINGS_COLOR_EVENT, { ...next, revision: ++settingsStateRevision })
          lastColor = signature
        } catch { /* 次の変更または完全な状態要求で復旧する。 */ }
      }
    })()
    sendingColor = run
    try { await run } finally { if (sendingColor === run) sendingColor = null }
  }

  /** 色変更だけを予約し、プリセット一覧や無関係な設定を複製しない。 */
  function publishColorState(next: Omit<SettingsColorState, 'revision'>): Promise<void> {
    if (disposed || !settingsWindowOpen.value) return Promise.resolve()
    pendingColor = { ...next, changes: { ...(pendingColor?.appearanceEpoch === next.appearanceEpoch ? pendingColor.changes : {}), ...next.changes } }
    colorFrame.schedule()
    return Promise.resolve()
  }

  /** 状態配信をbest-effortで行い、閉じかけの設定ウィンドウで保存処理を止めない。 */
  async function publishState(): Promise<void> {
    if (disposed) return
    pendingColor = null; colorFrame.cancel(); lastColor = ''
    try {
      const targetWindow = settingsWindow ?? await WebviewWindow.getByLabel('settings')
      if (disposed || !targetWindow) return
      const snapshot: SettingsSnapshot = {
        ...options.getSnapshot(),
        revision: ++settingsStateRevision,
      }
      if (disposed) return
      await emitTo('settings', SETTINGS_STATE_EVENT, snapshot)
    } catch {
      // ウィンドウの破棄と競合した状態配信は設定保存へ影響させない。
    }
  }

  /** 終了前に子窓の入力を要求し、メインへの反映確認まで待つ。 */
  async function flushInputs(): Promise<void> {
    if (disposed) return
    const target = await WebviewWindow.getByLabel('settings')
    if (!target) return
    const requestId = crypto.randomUUID()
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { flushRequests.delete(requestId); reject(new Error('設定画面の入力を確認できませんでした。設定画面で再確認してください。')) }, 3000)
      flushRequests.set(requestId, { resolve, reject, timer })
    })
    try { await emitTo('settings', SETTINGS_FLUSH_INPUTS_EVENT, { requestId }); await result }
    finally { const pending = flushRequests.get(requestId); if (pending) clearTimeout(pending.timer); flushRequests.delete(requestId) }
  }

  /** 設定画面へ保存エラーをbest-effortで通知する。 */
  async function publishError(detail: string): Promise<void> {
    if (disposed) return
    try {
      const targetWindow = await WebviewWindow.getByLabel('settings')
      if (disposed || !targetWindow) return
      await emitTo('settings', SETTINGS_ERROR_EVENT, detail)
    } catch {
      // メイン画面の通知を維持し、設定画面への通知失敗は保存状態へ波及させない。
    }
  }

  /** 設定子窓の破棄通知を現在の窓だけに適用する。 */
  function handleWindowDestroyed(destroyedWindow: WebviewWindow): void {
    if (settingsWindow !== destroyedWindow) return
    pendingColor = null; colorFrame.cancel(); lastColor = ''
    settingsWindow = null
    settingsWindowOpening = false
    settingsWindowOpen.value = false
    if (!disposed) options.onDestroyed(destroyedWindow)
  }

  /** 設定子窓を開き、既存窓があれば状態を配信して前面へ移す。 */
  async function open(): Promise<void> {
    if (disposed || settingsWindowOpening) return
    settingsWindowOpening = true
    try {
      const existing = await WebviewWindow.getByLabel('settings')
      if (disposed) return
      if (existing) {
        // getByLabel は毎回別のラッパーを返すため、破棄通知を登録した参照を維持する。
        if (!settingsWindow) {
          settingsWindow = existing
          void existing.once('tauri://destroyed', () => handleWindowDestroyed(existing))
        }
        settingsWindowOpen.value = true
        settingsWindowOpening = false
        await publishState()
        if (!disposed) await existing.setFocus()
        return
      }

      settingsWindowOpen.value = true
      const createdSettingsWindow = new WebviewWindow('settings', {
        url: 'settings.html',
        title: '設定',
        parent: 'main',
        center: true,
        width: 900,
        height: 680,
        minWidth: 700,
        minHeight: 520,
        decorations: true,
        // WindowsのWebView2ではTauriのファイルドロップとHTML5のドラッグ＆ドロップが競合するため無効化する。
        dragDropEnabled: false,
      })
      settingsWindow = createdSettingsWindow
      void createdSettingsWindow.once('tauri://destroyed', () => handleWindowDestroyed(createdSettingsWindow))
      void createdSettingsWindow.once('tauri://created', () => { settingsWindowOpening = false })
      void createdSettingsWindow.once('tauri://error', (event) => {
        settingsWindowOpening = false
        settingsWindowOpen.value = false
        if (!disposed) void options.showError('設定画面を開く操作', event.payload)
      })
    } catch (error) {
      settingsWindowOpening = false
      settingsWindowOpen.value = false
      if (!disposed) await options.showError('設定画面を開く操作', error)
    }
  }

  /** 設定イベント購読を一度だけ開始し、破棄競合時は遅着購読を解除する。 */
  async function setup(): Promise<void> {
    if (disposed || unlistenSettingsCommand) return
    if (setupPromise) return setupPromise
    const setupRun = (async () => {
      const lateUnlisten = await listen<SettingsCommand>(SETTINGS_COMMAND_EVENT, (event) => {
        const command = event.payload
        if (command.type === 'input-barrier') {
          void emitTo('settings', SETTINGS_INPUT_ACK_EVENT, { requestId: command.requestId }).catch(() => undefined)
        } else if (command.type === 'inputs-flushed') {
          const pending = flushRequests.get(command.requestId)
          if (pending) { clearTimeout(pending.timer); flushRequests.delete(command.requestId); if (command.error) pending.reject(new Error(command.error)); else pending.resolve() }
        } else void options.onCommand(command)
      })
      if (disposed) {
        lateUnlisten()
        return
      }
      unlistenSettingsCommand = lateUnlisten
    })()
    setupPromise = setupRun
    try {
      await setupRun
    } finally {
      if (setupPromise === setupRun) setupPromise = null
    }
  }

  /** 設定イベント購読と設定子窓を破棄し、遅着イベントから状態を守る。 */
  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    colorFrame.dispose(); pendingColor = null
    for (const pending of flushRequests.values()) { clearTimeout(pending.timer); pending.reject(new Error('設定画面との通信が終了しました。')) }
    flushRequests.clear()
    unlistenSettingsCommand?.()
    unlistenSettingsCommand = undefined
    settingsWindowOpen.value = false
    settingsWindowOpening = false
    const closingWindow = settingsWindow
    settingsWindow = null
    if (closingWindow) {
      try {
        await closingWindow.destroy()
      } catch {
        // 終了中の設定窓は既に破棄済みでもよい。
      }
    }
  }

  return {
    settingsWindowOpen,
    open,
    publishState,
    publishColorState,
    flushInputs,
    publishError,
    setup,
    dispose,
  }
}
