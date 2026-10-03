/** 前面のメイン窓だけで外部更新を監視し、購読・タイマーの寿命を管理する。 */
import type { getCurrentWindow } from '@tauri-apps/api/window'

type MonitorOptions = {
  appWindow: Pick<ReturnType<typeof getCurrentWindow>, 'isFocused' | 'onFocusChanged'>
  check: () => Promise<void>
  onError: (error: unknown) => void
}

/** フォーカス復帰時と前面での5秒間隔で確認する。文書側が操作中の要求を抑止する。 */
export function useExternalFileMonitor(options: MonitorOptions) {
  let disposed = false
  let focused = false
  let focusRevision = 0
  let unlisten: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let setupPromise: Promise<void> | null = null

  /** 画面破棄後や背面ではI/Oを発生させず、予期しない失敗も未処理にしない。 */
  async function check(): Promise<void> {
    if (disposed || !focused) return
    try { await options.check() }
    catch (error) { if (!disposed) options.onError(error) }
  }

  /** 購読完了後に前面状態を取得し、遅着した初期値で新しいフォーカス通知を上書きしない。 */
  async function setup(): Promise<void> {
    if (disposed || timer) return
    if (setupPromise) return setupPromise
    setupPromise = (async () => {
      try {
        const release = await options.appWindow.onFocusChanged(({ payload }) => {
          if (disposed) return
          focusRevision += 1
          focused = payload
          if (focused) void check()
        })
        if (disposed) { release(); return }
        unlisten = release
        const revision = focusRevision
        const initial = await options.appWindow.isFocused()
        if (disposed) return
        if (revision === focusRevision) focused = initial
        timer = setInterval(() => { void check() }, 5000)
        await check()
      } catch (error) {
        unlisten?.()
        unlisten = undefined
        if (!disposed) options.onError(error)
      } finally { setupPromise = null }
    })()
    return setupPromise
  }

  /** 終了後は確認を起動せず、購読待ちの解除もsetup側で行う。 */
  function dispose(): void {
    disposed = true
    if (timer) clearInterval(timer)
    timer = undefined
    unlisten?.()
    unlisten = undefined
  }

  return { setup, dispose }
}
