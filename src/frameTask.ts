/** 描画直前に最新値をまとめる。背景窓で描画が止まっても50ms以内に処理を開始する。 */
export function createFrameTask(run: () => void) {
  // APIがない環境ではタイマーを使う。生成時に保持し、後で環境が変わっても予約を解除できるようにする。
  const requestFrame = typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame.bind(globalThis) : undefined
  const cancelFrame = typeof globalThis.cancelAnimationFrame === 'function' ? globalThis.cancelAnimationFrame.bind(globalThis) : undefined
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  /** 保留中の描画・期限を解除し、二重実行を防ぐ。 */
  function cancel(): void {
    if (frame !== undefined) cancelFrame?.(frame)
    if (timer !== undefined) clearTimeout(timer)
    frame = undefined; timer = undefined
  }
  /** 操作確定時は描画待ちをせず、最後の値を処理する。 */
  function flush(): void { if (disposed || timer === undefined) return; cancel(); run() }
  /** 同じフレームの要求を一つにまとめ、非表示窓にも期限を設ける。 */
  function schedule(): void {
    if (disposed || timer !== undefined) return
    timer = setTimeout(flush, requestFrame ? 50 : 16)
    if (requestFrame) frame = requestFrame(flush)
  }
  /** 破棄後には予約済み処理を実行しない。 */
  function dispose(): void { cancel(); disposed = true }
  return { schedule, flush, cancel, dispose }
}
