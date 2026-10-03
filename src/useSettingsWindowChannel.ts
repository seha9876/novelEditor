/** 設定子窓の入力集約・順序確認・状態同期を担当し、保存はメイン窓へ委ねる。 */
import { ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import { createFrameTask } from './frameTask'
import { colorKeys, isHexColor, type ColorKey, type Palette } from './appearance'
import {
  SETTINGS_COMMAND_EVENT, SETTINGS_ERROR_EVENT, SETTINGS_STATE_EVENT, SETTINGS_COLOR_EVENT,
  SETTINGS_INPUT_ACK_EVENT, SETTINGS_FLUSH_INPUTS_EVENT,
  type SettingsCommand, type SettingsSnapshot, type SettingsColorState,
} from './settingsSession'

type ColorCommand = Extract<SettingsCommand, { type: 'appearance' }> & { action: Extract<Extract<SettingsCommand, { type: 'appearance' }>['action'], { type: 'color' }> }
type SettingsWindowChannelOptions = { onSnapshot?: (snapshot: SettingsSnapshot) => void }

/** 同一操作の中間値をまとめ、古い返信では入力中の色を巻き戻さない。 */
export function useSettingsWindowChannel(options: SettingsWindowChannelOptions = {}) {
  const snapshot = ref<SettingsSnapshot | null>(null), errorMessage = ref('')
  const listeners: (() => void)[] = []
  const pending: ColorCommand[] = []
  const optimistic = new Map<ColorKey, ColorCommand>()
  const barriers = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let confirmed: Partial<Palette> = {}, sequence = 0, lastSnapshotRevision = -1
  let setupPromise: Promise<void> | null = null, sending: Promise<void> | null = null
  let disposed = false, inputError: unknown = null
  const frame = createFrameTask(() => { void flushColors().catch(() => undefined) })

  /** メインで確定した色に未確認の最新入力を重ね、返信によるちらつきを防ぐ。 */
  function displayColors(): void {
    if (!snapshot.value) return
    for (const key of colorKeys) {
      const value = optimistic.get(key)?.action.value ?? confirmed[key]
      if (value !== undefined && snapshot.value.appearance.colors[key] !== value) snapshot.value.appearance.colors[key] = value
    }
  }

  /** 完全な状態の世代が変わったら旧入力を捨て、復元結果を優先する。 */
  function receiveSnapshot(next: SettingsSnapshot): void {
    if (disposed || next.revision < lastSnapshotRevision) return
    lastSnapshotRevision = next.revision
    const epochChanged = (snapshot.value?.appearanceEpoch ?? 0) !== (next.appearanceEpoch ?? 0)
    if (epochChanged) { pending.length = 0; optimistic.clear(); frame.cancel(); inputError = null }
    confirmed = { ...next.appearance.colors }
    for (const [key, command] of optimistic) if (confirmed[key] === command.action.value && !pending.includes(command)) optimistic.delete(key)
    snapshot.value = next
    displayColors()
    options.onSnapshot?.(snapshot.value)
  }

  /** 軽量返信は色と履歴表示だけ更新し、無関係な設定の参照を維持する。 */
  function receiveColor(next: SettingsColorState): void {
    if (disposed || !snapshot.value || next.revision <= lastSnapshotRevision || next.appearanceEpoch !== snapshot.value.appearanceEpoch) return
    lastSnapshotRevision = next.revision
    Object.assign(confirmed, next.changes)
    if (next.input) for (const [key, command] of optimistic) {
      if ((command.colorInput?.sequence ?? 0) <= next.input.sequence && confirmed[key] === command.action.value) optimistic.delete(key)
    }
    snapshot.value.history = next.history
    displayColors()
  }

  /** 通信中は次の操作の最新値だけを保持し、同じ操作の通知を積み上げない。 */
  async function flushColors(): Promise<void> {
    frame.cancel()
    if (sending) { await sending; if (inputError) throw inputError; return }
    inputError = null
    const run = (async () => {
      while (pending.length && !disposed) {
        const command = pending.shift()!
        try { await emitTo('main', SETTINGS_COMMAND_EVENT, command) }
        catch (error) {
          inputError = error
          if (pending[0]?.action.key !== command.action.key || pending[0]?.action.interactionId !== command.action.interactionId) pending.unshift(command)
          if (!disposed) errorMessage.value = `色の変更を送信できませんでした。${String(error)}`
          throw error
        }
      }
    })()
    sending = run
    try { await run } finally { if (sending === run) sending = null }
    if (inputError) throw inputError
  }

  /** 色の送信後にメイン側の応答を待ち、終了や後続操作が先行しないようにする。 */
  async function flush(): Promise<void> {
    await flushColors()
    if (disposed) return
    const requestId = crypto.randomUUID()
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { barriers.delete(requestId); reject(new Error('色の変更の反映を確認できませんでした。もう一度お試しください。')) }, 2000)
      barriers.set(requestId, { resolve, reject, timer })
    })
    try { await emitTo('main', SETTINGS_COMMAND_EVENT, { type: 'input-barrier', requestId }); await result }
    finally { const item = barriers.get(requestId); if (item) clearTimeout(item.timer); barriers.delete(requestId) }
  }

  /** 色入力は即時表示してフレーム送信し、他の操作は先行入力の送信後に実行する。 */
  async function sendCommand(command: SettingsCommand): Promise<void> {
    if (disposed) return
    errorMessage.value = ''
    if (command.type === 'appearance' && command.action.type === 'color') {
      if (!isHexColor(command.action.value) || !colorKeys.includes(command.action.key)) { errorMessage.value = '色は #RRGGBB 形式で指定してください。'; return }
      inputError = null
      const next: ColorCommand = { type: 'appearance', action: { ...command.action, value: command.action.value.toUpperCase() }, colorInput: { epoch: snapshot.value?.appearanceEpoch ?? 0, sequence: ++sequence } }
      const previous = pending.at(-1)
      if (previous?.action.key === next.action.key && previous.action.interactionId === next.action.interactionId) pending[pending.length - 1] = next
      else pending.push(next)
      optimistic.set(next.action.key, next); displayColors(); frame.schedule()
      return
    }
    try {
      if (pending.length || sending || optimistic.size) await flush()
      if (!disposed) await emitTo('main', SETTINGS_COMMAND_EVENT, command)
    } catch (error) { if (!disposed) errorMessage.value = String(error) }
  }

  /** 途中失敗や破棄と競合した購読も解除し、開始処理を再試行できるようにする。 */
  async function subscribe<T>(name: string, receive: (payload: T) => void): Promise<void> {
    const remove = await listen<T>(name, event => receive(event.payload))
    if (disposed) remove(); else listeners.push(remove)
  }

  /** 状態・入力確認・終了要求の購読を開始してから、設定画面を利用可能にする。 */
  async function setup(): Promise<void> {
    if (disposed || listeners.length && !setupPromise) return
    if (setupPromise) return setupPromise
    const run = (async () => {
      await subscribe<SettingsSnapshot>(SETTINGS_STATE_EVENT, receiveSnapshot)
      await subscribe<SettingsColorState>(SETTINGS_COLOR_EVENT, receiveColor)
      await subscribe<string>(SETTINGS_ERROR_EVENT, detail => { if (!disposed) errorMessage.value = detail })
      await subscribe<{ requestId: string }>(SETTINGS_INPUT_ACK_EVENT, ({ requestId }) => {
        const item = barriers.get(requestId); if (item) { clearTimeout(item.timer); barriers.delete(requestId); item.resolve() }
      })
      await subscribe<{ requestId: string }>(SETTINGS_FLUSH_INPUTS_EVENT, ({ requestId }) => {
        void flush().then(() => emitTo('main', SETTINGS_COMMAND_EVENT, { type: 'inputs-flushed', requestId }), error => {
          if (!disposed) errorMessage.value = String(error)
          return emitTo('main', SETTINGS_COMMAND_EVENT, { type: 'inputs-flushed', requestId, error: String(error) })
        }).catch(() => undefined)
      })
    })()
    setupPromise = run
    try { await run } catch (error) { clearListeners(); throw error }
    finally { if (setupPromise === run) setupPromise = null }
  }

  /** 開始済み購読を解除し、再登録で二重受信しないようにする。 */
  function clearListeners(): void { listeners.splice(0).forEach(remove => remove()) }

  /** 正常終了では先にflushを待ち、破棄後の予約・通知・確認待ちをすべて止める。 */
  function dispose(): void {
    if (disposed) return
    disposed = true; frame.dispose(); pending.length = 0; clearListeners()
    for (const item of barriers.values()) { clearTimeout(item.timer); item.reject(new Error('設定画面が閉じられました。')) }
    barriers.clear()
  }
  return { snapshot, errorMessage, sendCommand, flushColors, flush, setup, dispose }
}
