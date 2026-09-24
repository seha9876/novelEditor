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

/** 単一Workerとの最小限の境界。テストでは通信だけを置き換えられる。 */
export type StatisticsWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>

/** 全文計数を250msでまとめ、処理中は最新状態1件だけを保持する。差分計数は行わない。 */
export class StatisticsController {
  private state = createEmptyStatistics()
  private text = ''
  private selection: SelectionStatisticsInput = { ranges: [], line: '', offset: 0, lineNumber: 1, lineCount: 1 }
  private documentId = 0
  private selectionId = 0
  private needsDocument = false
  private needsSelection = false
  private running = false
  private stopped = false
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined

  /** Workerの応答を接続し、失敗時も本文側の処理には例外を伝えない。 */
  constructor(private worker: StatisticsWorker, private notify: (statistics: EditorStatistics) => void) {
    worker.onmessage = (event: MessageEvent<StatisticsResponse>) => this.receive(event.data)
    worker.onerror = (event) => {
      event.preventDefault()
      this.fail('文字数の集計に失敗しました。アプリを再起動すると再試行します。')
    }
    worker.onmessageerror = () => this.fail('統計の受信に失敗しました。アプリを再起動すると再試行します。')
  }

  /** 本文の最新値を予約する。集計失敗後も文書切替・編集で古い確定値を消す。 */
  updateDocument(text: string, selection: SelectionStatisticsInput, reset = false): void {
    if (this.disposed) return
    if (reset || this.stopped) {
      this.state = { ...createEmptyStatistics(), pending: !this.stopped, error: this.state.error }
    }
    if (this.stopped) {
      this.updateSelection(selection)
      return
    }
    this.text = text
    this.documentId += 1
    this.needsDocument = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.send()
    }, 250)
    this.updateSelection(selection)
  }

  /** 選択移動では全文を再計数しない。集計停止中も計数不要な行・範囲数は更新する。 */
  updateSelection(selection: SelectionStatisticsInput): void {
    if (this.disposed) return
    if (this.stopped) {
      this.state = {
        ...this.state, selection: null, column: null, selectionRanges: selection.ranges.length,
        line: selection.lineNumber, lineCount: selection.lineCount, pending: false,
      }
      this.publish()
      return
    }
    this.selection = selection
    this.selectionId += 1
    this.needsSelection = true
    this.state = {
      ...this.state, selectionRanges: selection.ranges.length,
      line: selection.lineNumber, lineCount: selection.lineCount, pending: true,
    }
    this.publish()
    this.send()
  }

  /** 計算中とデバウンス中は送信せず、必要な最新データだけを1回渡す。 */
  private send(): void {
    if (this.stopped || this.running || this.timer !== undefined || !this.needsSelection && !this.needsDocument) return
    const request: StatisticsRequest = {
      documentId: this.documentId, selectionId: this.selectionId,
      text: this.needsDocument ? this.text : undefined, selection: this.selection,
    }
    this.running = true
    this.needsSelection = false
    try {
      this.worker.postMessage(request)
    } catch {
      this.fail('統計の送信に失敗しました。アプリを再起動すると再試行します。')
    }
  }

  /** 本文と選択それぞれの番号を確認し、遅着した結果で表示を戻さない。 */
  private receive(result: StatisticsResponse): void {
    if (this.stopped) return
    this.running = false
    if (result.error) {
      this.fail(result.error)
      return
    }
    if (result.documentId === this.documentId) {
      if (result.document) {
        this.state.document = result.document
        this.needsDocument = false
      }
      if (result.selectionId === this.selectionId && result.selection && result.column !== undefined) {
        this.state.selection = result.selection
        this.state.column = result.column
      }
    }
    this.state.pending = this.needsDocument || this.needsSelection
    this.publish()
    this.send()
  }

  /** Vue等へ渡す状態を複製し、次の更新が過去の通知を変更しないようにする。 */
  private publish(): void {
    this.notify({ ...this.state })
  }

  /** 集計だけを停止し、入力・保存を継続できるエラー状態を通知する。 */
  private fail(error: string): void {
    if (this.stopped) return
    this.stopWorker()
    this.state = { ...this.state, pending: false, error }
    this.publish()
  }

  /** 画面破棄時に予約とWorkerを終了し、遅延通知を防ぐ。 */
  dispose(): void {
    this.disposed = true
    this.stopWorker()
  }

  /** 計数資源だけを停止する。エラー後も表示状態を更新できるよう画面破棄とは分ける。 */
  private stopWorker(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.worker.terminate()
  }
}
