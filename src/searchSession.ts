/** メインと検索ウィンドウで共有する条件。本文やファイルパスはイベントに含めない。 */
export type SearchConditions = { search: string; replace: string; caseSensitive: boolean; regexp: boolean }
export type SearchField = 'search' | 'replace'
export type SearchAction = 'next' | 'previous' | 'replace' | 'replaceAll'
export type SearchStatus = 'empty' | 'invalid' | 'notFound' | 'found'

export const SEARCH_COMMAND_EVENT = 'editor-search-command'
export const SEARCH_STATE_EVENT = 'editor-search-state'

export type SearchCommand =
  | { type: 'ready'; sessionId: string }
  | { type: 'close'; sessionId: string; sequence: number; documentRevision: number; conditions?: SearchConditions }
  | {
      type: 'change' | 'action'
      sessionId: string
      sequence: number
      documentRevision: number
      conditions: SearchConditions
      action?: SearchAction
    }

export type SearchSnapshot = {
  sessionId: string
  conditions: SearchConditions
  status: SearchStatus
  locked: boolean
  documentRevision: number
  acknowledgedSequence: number
  revision: number
  focus: { field: SearchField; revision: number }
  error: string
}

/** 検索条件の初期値を返す。条件はファイルへ保存せずアプリのセッション内だけで保持する。 */
export function createSearchConditions(): SearchConditions {
  return { search: '', replace: '', caseSensitive: false, regexp: false }
}

/** 条件の更新順序と文書ロックの境界を管理し、遅延した置換を別文書へ適用させない。 */
export class SearchSession {
  conditions = createSearchConditions()
  sessionId: string | null = null
  sequence = 0
  documentRevision = 0
  locked = true

  /** 新しいウィンドウの連番を開始する。以前のウィンドウの条件は引き継ぐ。 */
  start(sessionId: string): void {
    this.sessionId = sessionId
    this.sequence = 0
  }

  /** 閉じたウィンドウから遅れて届く要求を無効化し、条件だけを残す。 */
  stop(): void {
    this.sessionId = null
  }

  /** 文書操作の開始と終了ごとに世代を進め、ロック中に送られた要求も後から実行しない。 */
  setLocked(locked: boolean): void {
    if (this.locked === locked) return
    this.locked = locked
    this.documentRevision += 1
  }

  /** 最新条件を受け取り、同じ文書世代で操作可能な要求にだけ実行許可を返す。 */
  receive(command: Exclude<SearchCommand, { type: 'ready' }>): { accepted: boolean; action?: SearchAction } {
    if (command.sessionId !== this.sessionId || command.sequence <= this.sequence) return { accepted: false }
    this.sequence = command.sequence
    if (command.conditions) this.conditions = { ...command.conditions }
    return {
      accepted: true,
      action: command.type === 'action' && !this.locked && command.documentRevision === this.documentRevision
        ? command.action : undefined,
    }
  }
}
