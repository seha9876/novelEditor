/** 解析1回のWorkerとタイムアウトを管理し、中止後の応答を適用しない。 */
import type { OutlinePreferences } from './outline'
import type { SearchConditions } from './searchSession'
export type AnalysisRequest = { kind: 'outline'; text: string; preferences: OutlinePreferences }
  | { kind: 'search'; text: string; conditions: SearchConditions; limit: number; scope: { from: number; to: number } | null }

/** 大きな本文や危険な正規表現でUIを固めず、明示的な失敗として返す。 */
export function runSidebarAnalysis<T>(request: AnalysisRequest, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('解析を中止しました。')); return }
    const worker = new Worker(new URL('./sidebar.worker.ts', import.meta.url), { type: 'module' })
    let finished = false
    const timer = setTimeout(() => finish(new Error('解析に時間がかかりすぎています。検索条件・見出しルールを見直してください。')), 2000)
    /** 全終了経路でWorkerと購読を解放し、二重応答を無視する。 */
    function finish(error?: Error, result?: T): void {
      if (finished) return
      finished = true; clearTimeout(timer); worker.terminate(); signal?.removeEventListener('abort', abort)
      if (error) reject(error); else resolve(result!)
    }
    /** 非表示・文書切替時の解析を停止する。 */
    function abort(): void { finish(new Error('解析を中止しました。')) }
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = event => finish(event.data.error ? new Error(event.data.error) : undefined, event.data.result)
    worker.onerror = () => finish(new Error('本文解析を実行できませんでした。'))
    try { worker.postMessage(request) } catch { finish(new Error('本文解析へデータを渡せませんでした。')) }
  })
}
