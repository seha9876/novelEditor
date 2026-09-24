/** 別ウィンドウの検索条件を、本文のCodeMirror検索状態とUndo履歴へ接続する。 */
import { type Extension } from '@codemirror/state'
import { EditorView, keymap, type Panel } from '@codemirror/view'
import {
  closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel,
  replaceAll, replaceNext, search, SearchQuery, setSearchQuery,
} from '@codemirror/search'
import type { SearchAction, SearchConditions, SearchStatus } from './searchSession'

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
  const query = new SearchQuery({ ...conditions, literal: true })
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
  const query = getSearchQuery(view.state)
  if (!query.search) return 'empty'
  if (!query.valid) return 'invalid'
  return query.getCursor(view.state).next().done ? 'notFound' : 'found'
}
