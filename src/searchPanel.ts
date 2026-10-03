/** 別ウィンドウの検索条件を、本文のCodeMirror検索状態とUndo履歴へ接続する。 */
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, type Panel } from '@codemirror/view'
import {
  closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel,
  replaceAll, replaceNext, search, SearchQuery, setSearchQuery,
} from '@codemirror/search'
import type { SearchAction, SearchConditions, SearchScopeAction, SearchScopeStatus, SearchStatus } from './searchSession'

type SearchScopeRange = { from: number; to: number }
const setSearchScope = StateEffect.define<SearchScopeRange | null>()
const searchScope = StateField.define<SearchScopeRange | null>({
  create: () => null,
  /** 本文編集で位置を追従し、明示的な指定・解除だけで限定状態を切り替える。 */
  update(scope, transaction) {
    // 両端への挿入を含める。全削除で空になっても限定を残し、Undo時の挿入で復元できる。
    if (scope && transaction.docChanged) {
      scope = { from: transaction.changes.mapPos(scope.from, -1), to: transaction.changes.mapPos(scope.to, 1) }
    }
    for (const effect of transaction.effects) if (effect.is(setSearchScope)) scope = effect.value
    return scope
  },
})

/** 全文で判定された一致を範囲で絞り、正規表現の行境界・先読みの意味を保つ。 */
function matchWithinScope(_match: string, state: EditorState, from: number, to: number): boolean {
  const scope = state.field(searchScope, false)
  return !scope || (scope.from < scope.to && from >= scope.from && to <= scope.to)
}

/** 選択範囲と限定状態を、本文を含まない検索ウィンドウ用の情報へ変換する。 */
export function getEditorSearchScope(view: EditorView): SearchScopeStatus {
  const { state } = view
  const scope = state.field(searchScope, false)
  const singleSelection = state.selection.ranges.length === 1
  const canCapture = singleSelection && !state.selection.main.empty && !state.readOnly
  const empty = !!scope && scope.from === scope.to
  const reason = empty ? '対象範囲が空です。範囲を更新するか、限定を解除してください。'
    : state.readOnly ? '本文の処理が終わるまで範囲を変更できません。'
      : !singleSelection ? '複数の選択範囲は指定できません。連続した範囲を選択してください。'
        : !canCapture ? '本文で検索対象の範囲を選択してください。' : ''
  return {
    enabled: !!scope,
    empty,
    canCapture,
    startLine: scope ? state.doc.lineAt(scope.from).number : null,
    endLine: scope ? state.doc.lineAt(Math.max(scope.from, scope.to - 1)).number : null,
    reason,
  }
}

/** 現在の連続選択を固定するか限定を解除し、本文・選択・Undo履歴は変更しない。 */
export function updateEditorSearchScope(view: EditorView, action: SearchScopeAction): boolean {
  if (view.state.readOnly || (action === 'capture' && !getEditorSearchScope(view).canCapture)) return false
  const { from, to } = view.state.selection.main
  const query = new SearchQuery({ ...getSearchQuery(view.state), test: matchWithinScope })
  view.dispatch({ effects: [setSearchScope.of(action === 'capture' ? { from, to } : null), setSearchQuery.of(query)] })
  return true
}

/** 標準ハイライトを有効にする内部パネル。入力UIは検索ウィンドウだけに置く。 */
function createHiddenSearchPanel(): Panel {
  const dom = document.createElement('div')
  dom.hidden = true
  dom.setAttribute('aria-hidden', 'true')
  return { dom }
}

/** 本文の検索状態とF3操作を登録し、検索語がない場合は外部ウィンドウへ誘導する。 */
export function createSearchExtensions(onNavigate?: (action: SearchAction) => void): Extension {
  return [
    searchScope,
    search({ literal: true, createPanel: createHiddenSearchPanel }),
    // CodeMirror標準ハイライトはパネルが開いている間だけ動くため、内部パネルの領域だけを隠す。
    EditorView.theme({ '.cm-panels': { display: 'none' } }),
    keymap.of([
      { key: 'F3', run: () => { onNavigate?.('next'); return true }, preventDefault: true },
      { key: 'Shift-F3', run: () => { onNavigate?.('previous'); return true }, preventDefault: true },
    ]),
  ]
}

/** 条件とハイライトを同期する。パネル初期化による選択文字列の取り込みは共有条件で上書きする。 */
export function updateEditorSearch(view: EditorView, conditions: SearchConditions, active: boolean): void {
  if (active) openSearchPanel(view)
  else closeSearchPanel(view)
  const query = new SearchQuery({ ...conditions, literal: true, test: matchWithinScope })
  if (!query.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(query) })
}

/** 有効な条件だけで標準コマンドを実行する。ロック時は検索による選択移動も抑制する。 */
export function runEditorSearchAction(view: EditorView, action: SearchAction): void {
  if (view.state.readOnly || !getSearchQuery(view.state).valid) return
  const commands = { next: findNext, previous: findPrevious, replace: replaceNext, replaceAll }
  commands[action](view)
}

/** 最初の一致だけを調べ、長文での不要な全件走査を避けて結果を返す。 */
export function getEditorSearchStatus(view: EditorView): SearchStatus {
  if (getEditorSearchScope(view).empty) return 'notFound'
  const query = getSearchQuery(view.state)
  if (!query.search) return 'empty'
  if (!query.valid) return 'invalid'
  return query.getCursor(view.state).next().done ? 'notFound' : 'found'
}
