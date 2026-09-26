/** 統計Workerと表示側で共有する計算契約と純粋な計数処理をまとめる。 */
import { countColumn, countText, type TextCounts } from './textStatistics'

/** 全文とは別に更新する選択範囲と主カーソルの入力。範囲同士は連結しない。 */
export type SelectionStatisticsInput = {
  ranges: string[]
  line: string
  offset: number
  lineNumber: number
  lineCount: number
}

/** 本文通知から独立した統計の表示状態。未確定値はnullで表す。 */
export type EditorStatistics = {
  document: TextCounts | null
  selection: TextCounts | null
  selectionRanges: number
  line: number
  column: number | null
  lineCount: number
  pending: boolean
  error: string
}

/** 本文と選択に独立の要求番号を付け、カーソル移動で有効な全文結果を捨てない。 */
export type StatisticsRequest = {
  documentId: number
  selectionId: number
  text?: string
  selection: SelectionStatisticsInput
}

export type StatisticsResponse = {
  documentId: number
  selectionId: number
  document?: TextCounts
  selection?: TextCounts
  column?: number
  error?: string
}

/** 文書切替直後の、前文書の数字を含まない統計状態を作る。 */
export function createEmptyStatistics(): EditorStatistics {
  return { document: null, selection: null, selectionRanges: 0, line: 1, column: null, lineCount: 1, pending: true, error: '' }
}

/** Workerで全文・選択・現在列をまとめて計算する。計数方式は独立モジュールに集約する。 */
export function calculateStatistics(request: StatisticsRequest): StatisticsResponse {
  const selection = { characters: 0, withoutWhitespace: 0 }
  for (const text of request.selection.ranges) {
    const counts = countText(text)
    selection.characters += counts.characters
    selection.withoutWhitespace += counts.withoutWhitespace
  }
  return {
    documentId: request.documentId,
    selectionId: request.selectionId,
    document: request.text === undefined ? undefined : countText(request.text),
    selection,
    column: countColumn(request.selection.line, request.selection.offset),
  }
}
