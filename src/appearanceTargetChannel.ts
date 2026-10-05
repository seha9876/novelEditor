/** 配色の対象表示だけを共有する。設定保存・本文編集・Undoの通信は通さない。 */
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { colorKeys, type ColorKey } from './appearance'

export const APPEARANCE_TARGET_COMMAND = 'editor-appearance-target-command'
export const APPEARANCE_TARGET_STATE = 'editor-appearance-target-state'
export const APPEARANCE_TARGET_REQUEST = 'editor-appearance-target-request'
export type AppearanceTargetCommand = { session: string; sequence: number; key: ColorKey | null }
export type AppearanceTargetState = { revision: number; key: ColorKey | null }

/** 外部イベントを限定された配色キーとして検証する。 */
function isTargetKey(key: unknown): key is ColorKey | null {
  return key === null || colorKeys.includes(key as ColorKey)
}

/** 設定窓の世代と入力順序を確認し、現在の対象だけを各窓へ配信する。 */
export function createAppearanceTargetHost(apply: (key: ColorKey | null) => void) {
  let session: string | null = null
  let sequence = 0
  let revision = 0
  let key: ColorKey | null = null
  let disposed = false
  let generation = 0
  const listeners: (() => void)[] = []

  /** 通知の失敗は保存エラーにしない。新しい窓は状態要求から再取得できる。 */
  async function publish(): Promise<void> {
    try { await emit(APPEARANCE_TARGET_STATE, { revision, key } satisfies AppearanceTargetState) }
    catch { /* 終了中の窓への通知失敗は次の状態要求で回復する。 */ }
  }

  /** 対象が変わったときだけ描画と通知を行う。 */
  function update(next: ColorKey | null): void {
    if (disposed || next === key) return
    key = next
    revision += 1
    apply(key)
    void publish()
  }

  /** 窓を開き直すたびに順序を初期化し、旧窓からの通知を受け付けない。 */
  function setSession(next: string | null): void {
    if (disposed || session === next) return
    session = next
    sequence = 0
    update(null)
  }

  /** 購読開始中に破棄された場合も、遅れて作成された購読を解除する。 */
  async function setup(): Promise<void> {
    if (disposed || listeners.length) return
    const activeGeneration = ++generation
    const removeCommand = await listen<AppearanceTargetCommand>(APPEARANCE_TARGET_COMMAND, ({ payload }) => {
      if (disposed || !session || !payload || payload.session !== session || !Number.isSafeInteger(payload.sequence) || payload.sequence <= sequence || !isTargetKey(payload.key)) return
      sequence = payload.sequence
      update(payload.key)
    })
    if (disposed || activeGeneration !== generation) { removeCommand(); return }
    listeners.push(removeCommand)
    try {
      const removeRequest = await listen(APPEARANCE_TARGET_REQUEST, () => { if (!disposed) void publish() })
      if (disposed || activeGeneration !== generation) removeRequest()
      else listeners.push(removeRequest)
    } catch (error) { dispose(); throw error }
  }

  /** アプリ終了時には購読とローカルの強調を必ず解除する。 */
  function dispose(): void {
    disposed = true
    generation += 1
    listeners.splice(0).forEach(remove => remove())
    apply(null)
  }
  return { setup, setSession, dispose }
}

/** 子窓は最新の対象表示を取得し、逆順で届いた通知を無視する。 */
export function createAppearanceTargetClient(apply: (key: ColorKey | null) => void) {
  let revision = -1
  let disposed = false
  let unlisten: (() => void) | undefined
  /** 状態購読が成立してから現在値を要求する。 */
  async function setup(): Promise<void> {
    if (disposed || unlisten) return
    const remove = await listen<AppearanceTargetState>(APPEARANCE_TARGET_STATE, ({ payload }) => {
      if (disposed || !payload || !Number.isSafeInteger(payload.revision) || payload.revision <= revision || !isTargetKey(payload.key)) return
      revision = payload.revision
      apply(payload.key)
    })
    if (disposed) { remove(); return }
    unlisten = remove
    try { await emitTo('main', APPEARANCE_TARGET_REQUEST) }
    catch (error) { unlisten?.(); unlisten = undefined; throw error }
  }
  /** 購読と残っている強調を、画面破棄時に解除する。 */
  function dispose(): void { disposed = true; unlisten?.(); unlisten = undefined; apply(null) }
  return { setup, dispose }
}

/** 送信を直列化し、通信待ちには最後の対象だけを保持する。 */
export function createAppearanceTargetSender(session: string) {
  let sequence = 0
  let pending: AppearanceTargetCommand | null = null
  let sending: Promise<void> | null = null
  let disposed = false
  /** 古い強調が解除通知より後に送られないよう、配送順を揃える。 */
  async function flush(): Promise<void> {
    if (sending) return sending
    const run = (async () => {
      while (pending) {
        const next = pending
        pending = null
        try { await emitTo('main', APPEARANCE_TARGET_COMMAND, next) }
        catch { /* 対象表示の通信失敗は色変更の失敗と混同しない。 */ }
      }
    })()
    sending = run
    try { await run } finally { sending = null }
  }
  /** 同期された設定窓の識別子があるときだけ対象を送る。 */
  function update(key: ColorKey | null): void {
    if (disposed || !session) return
    pending = { session, sequence: ++sequence, key }
    void flush()
  }
  /** 終了時は最後に解除を送り、それ以降の入力を拒否する。 */
  function dispose(): void { update(null); disposed = true }
  return { update, flush, dispose }
}
