/** 設定子窓とメイン画面のイベント通信、revision管理、破棄競合を分離する。 */
import { ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import {
  SETTINGS_COMMAND_EVENT,
  SETTINGS_ERROR_EVENT,
  SETTINGS_STATE_EVENT,
  type SettingsCommand,
  type SettingsSnapshot,
} from './settingsSession'

type SettingsWindowChannelOptions = {
  onSnapshot?: (snapshot: SettingsSnapshot) => void
}

/** 設定画面との状態・コマンド通信を所有し、遅着イベントを無視する。 */
export function useSettingsWindowChannel(options: SettingsWindowChannelOptions = {}) {
  const snapshot = ref<SettingsSnapshot | null>(null)
  const errorMessage = ref('')
  let lastSnapshotRevision = -1
  let unlistenState: (() => void) | undefined
  let unlistenError: (() => void) | undefined
  let setupPromise: Promise<void> | null = null
  let disposed = false

  /** revisionが古い状態を捨て、現在の設定スナップショットだけを画面へ渡す。 */
  function receiveSnapshot(nextSnapshot: SettingsSnapshot): void {
    if (disposed || nextSnapshot.revision < lastSnapshotRevision) return
    lastSnapshotRevision = nextSnapshot.revision
    snapshot.value = nextSnapshot
    options.onSnapshot?.(nextSnapshot)
  }

  /** メイン画面へ設定コマンドを送信し、失敗だけを画面内エラーへ反映する。 */
  async function sendCommand(command: SettingsCommand): Promise<void> {
    if (disposed) return
    errorMessage.value = ''
    try {
      await emitTo('main', SETTINGS_COMMAND_EVENT, command)
    } catch (error) {
      if (!disposed) errorMessage.value = String(error)
    }
  }

  /** 状態とエラーの購読を一度だけ開始し、破棄後に遅着した解除関数も実行する。 */
  async function setup(): Promise<void> {
    if (disposed || unlistenState || unlistenError) return
    if (setupPromise) return setupPromise
    const setupRun = (async () => {
      const lateStateUnlisten = await listen<SettingsSnapshot>(SETTINGS_STATE_EVENT, (event) => {
        receiveSnapshot(event.payload)
      })
      if (disposed) {
        lateStateUnlisten()
        return
      }
      unlistenState = lateStateUnlisten

      const lateErrorUnlisten = await listen<string>(SETTINGS_ERROR_EVENT, (event) => {
        if (!disposed) errorMessage.value = event.payload
      })
      if (disposed) {
        lateErrorUnlisten()
        unlistenState?.()
        unlistenState = undefined
        return
      }
      unlistenError = lateErrorUnlisten
    })()
    setupPromise = setupRun
    try {
      await setupRun
    } finally {
      if (setupPromise === setupRun) setupPromise = null
    }
  }

  /** イベント購読を解除し、破棄後の状態通知を止める。 */
  function dispose(): void {
    if (disposed) return
    disposed = true
    unlistenState?.()
    unlistenError?.()
    unlistenState = undefined
    unlistenError = undefined
  }

  return {
    snapshot,
    errorMessage,
    sendCommand,
    setup,
    dispose,
  }
}
