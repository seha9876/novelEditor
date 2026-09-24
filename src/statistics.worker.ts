import { calculateStatistics, type StatisticsRequest, type StatisticsResponse } from './editorStatistics'

// UIやCodeMirrorを読み込まず、同じ独立計数関数をWorker内で実行する。
self.onmessage = (event: MessageEvent<StatisticsRequest>) => {
  const request = event.data
  let response: StatisticsResponse
  try {
    response = calculateStatistics(request)
  } catch {
    response = {
      documentId: request.documentId, selectionId: request.selectionId,
      error: '文字数の集計に失敗しました。アプリを再起動すると再試行します。',
    }
  }
  self.postMessage(response)
}
