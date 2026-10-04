/** 正規表現を含む本文解析はWorkerで実行し、時間超過時には親側から破棄できるようにする。 */
import { extractOutline } from './outline'
import { findTextMatches } from './sidebarAnalysis'
import type { AnalysisRequest } from './sidebarWorker'
self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  try {
    const request = event.data
    const result = request.kind === 'outline' ? extractOutline(request.text, request.preferences)
      : findTextMatches(request.text, request.conditions, request.limit, request.scope)
    self.postMessage({ result })
  } catch (error) { self.postMessage({ error: String(error) }) }
}
