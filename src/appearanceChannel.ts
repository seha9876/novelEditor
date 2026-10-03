/** 配色だけを全ウィンドウへ配信する。保存の責務はメイン窓に残す。 */
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { colorKeys, type Palette } from './appearance'
import { createFrameTask } from './frameTask'

export const APPEARANCE_STATE_EVENT = 'editor-appearance-state'
export const APPEARANCE_REQUEST_EVENT = 'editor-appearance-request'
type AppearanceSnapshot = { revision: number; colors: Palette }

/** メイン窓が現在の配色を所有し、後から起動する窓にも同じ状態を返す。 */
export function createAppearanceHost(initial: Palette, apply: (colors: Palette) => void) {
  let colors = { ...initial }
  let revision = 0
  let disposed = false
  let unlisten: (() => void) | undefined
  let setupPromise: Promise<void> | undefined
  let publishing: Promise<void> | null = null
  let publishAgain = false
  const frame = createFrameTask(() => { apply(colors); void publish() })
  apply(colors)

  /** 閉じかけの子窓などへの通知失敗を永続化の失敗として扱わない。 */
  async function publish(): Promise<void> {
    if (disposed) return
    if (publishing) { publishAgain = true; return publishing }
    const run = (async () => {
      do {
        publishAgain = false
        try { await emit(APPEARANCE_STATE_EVENT, { colors: { ...colors }, revision }) } catch { /* 次の状態要求で再送する。 */ }
      } while (publishAgain && !disposed)
    })()
    publishing = run
    try { await run } finally { if (publishing === run) publishing = null }
  }

  /** 現在値は即時更新し、表示と通知はフレーム単位で最新値へまとめる。 */
  function update(next: Palette): void {
    if (disposed) return
    if (colorKeys.every(key => next[key] === colors[key])) return
    colors = { ...next }
    revision += 1
    frame.schedule()
  }

  /** 起動要求の購読を重複させず開始し、破棄と競合した購読も解除する。 */
  async function setup(): Promise<void> {
    if (disposed || unlisten) return
    if (setupPromise) return setupPromise
    setupPromise = listen(APPEARANCE_REQUEST_EVENT, () => { void publish() }).then((remove) => {
      if (disposed) remove()
      else unlisten = remove
    })
    try { await setupPromise } finally { setupPromise = undefined }
  }

  /** アプリ終了時に新しい配信と状態要求を止める。 */
  function dispose(): void {
    disposed = true
    frame.dispose()
    unlisten?.()
  }
  /** 確定・終了時には保留中の最終色と通知を完了する。 */
  async function flush(): Promise<void> { frame.flush(); if (publishing) await publishing }
  return { update, setup, flush, dispose }
}

/** 子窓は購読後に現在値を要求し、古い通知や破棄後の通知を適用しない。 */
export function createAppearanceClient(apply: (colors: Palette) => void) {
  let revision = -1
  let disposed = false
  let unlisten: (() => void) | undefined
  let setupPromise: Promise<void> | undefined
  let latest: Palette | null = null
  const frame = createFrameTask(() => { if (latest) { apply(latest); latest = null } })

  /** 受信開始と初期値要求を順に実行する。途中失敗時は次回の開始を許可する。 */
  async function setup(): Promise<void> {
    if (disposed || unlisten) return
    if (setupPromise) return setupPromise
    setupPromise = (async () => {
      const remove = await listen<AppearanceSnapshot>(APPEARANCE_STATE_EVENT, ({ payload }) => {
        if (disposed || payload.revision <= revision) return
        revision = payload.revision
        latest = payload.colors
        frame.schedule()
      })
      if (disposed) { remove(); return }
      unlisten = remove
      await emitTo('main', APPEARANCE_REQUEST_EVENT)
    })()
    try { await setupPromise } catch (error) {
      clearListener()
      throw error
    } finally { setupPromise = undefined }
  }

  /** 開始途中の失敗でも購読だけを解除し、再試行を可能にする。 */
  function clearListener(): void {
    unlisten?.()
    unlisten = undefined
  }

  /** 子窓終了時に購読を解除する。 */
  function dispose(): void {
    disposed = true
    frame.dispose()
    clearListener()
  }
  /** 確認要求直後など、テストや確定処理では保留表示を直ちに適用する。 */
  function flush(): void { frame.flush() }
  return { setup, flush, dispose }
}
