/** 本文と履歴を実物のCodeMirror状態で動かし、限定検索の境界と別窓要求を検証する。 */
import { assert, loadSourceModule, require, test } from './test-support.mjs'

/** DOMだけを省いたエディターへ検索コアを接続する。 */
function createScopeView(text, conditions = {}, selection = { anchor: 0 }, readOnly = false) {
  const { EditorState, Transaction } = require('@codemirror/state')
  const { history } = require('@codemirror/commands')
  const api = loadSourceModule('src/searchPanel.ts')
  const view = {
    state: EditorState.create({ doc: text, selection,
      extensions: [api.createSearchExtensions(), history(), EditorState.allowMultipleSelections.of(true), EditorState.readOnly.of(readOnly)] }),
    plugin: () => null,
    dispatch: (transaction) => { view.state = transaction instanceof Transaction ? transaction.state : view.state.update(transaction).state },
  }
  const query = { search: '星', replace: '月', caseSensitive: false, regexp: false, ...conditions }
  api.updateEditorSearch(view, query, false)
  return { view, api, query }
}

/** 現在のクエリーを標準カーソルで評価する。 */
function matchRanges(view) {
  const { getSearchQuery } = require('@codemirror/search')
  return Array.from(getSearchQuery(view.state).getCursor(view.state)).map(({ from, to }) => [from, to])
}

test('範囲内だけを前後検索して折り返し、全文置換と1件置換で範囲外を保護する', () => {
  const { view, api } = createScopeView('星 星 星 星', {}, { anchor: 2, head: 5 })
  assert.equal(api.updateEditorSearchScope(view, 'capture'), true)
  assert.deepEqual(matchRanges(view), [[2, 3], [4, 5]])
  assert.deepEqual(api.getEditorSearchScope(view), { enabled: true, empty: false, canCapture: true, startLine: 1, endLine: 1, reason: '' })
  for (const [action, from] of [['next', 2], ['next', 4], ['next', 2], ['previous', 4]]) {
    api.runEditorSearchAction(view, action)
    assert.equal(view.state.selection.main.from, from)
  }
  api.runEditorSearchAction(view, 'replace')
  assert.equal(view.state.doc.toString(), '星 星 月 星')
  api.runEditorSearchAction(view, 'replaceAll')
  assert.equal(view.state.doc.toString(), '星 月 月 星')
  assert.equal(api.getEditorSearchStatus(view), 'notFound')
})

test('検索選択や検索窓の終了で範囲を変えず、明示的な更新・解除と文書切替に対応する', () => {
  const { view, api, query } = createScopeView('星\n星\n星', {}, { anchor: 0, head: 2 })
  api.updateEditorSearchScope(view, 'capture')
  assert.equal(api.getEditorSearchScope(view).endLine, 1)
  api.updateEditorSearch(view, query, true)
  api.runEditorSearchAction(view, 'next')
  api.updateEditorSearch(view, query, false)
  assert.deepEqual(matchRanges(view), [[0, 1]])
  view.dispatch({ selection: { anchor: 4, head: 5 } })
  assert.deepEqual(matchRanges(view), [[0, 1]])
  api.updateEditorSearchScope(view, 'capture')
  assert.deepEqual(matchRanges(view), [[4, 5]])
  assert.equal(api.getEditorSearchScope(view).startLine, 3)
  api.updateEditorSearchScope(view, 'clear')
  assert.deepEqual(matchRanges(view), [[0, 1], [2, 3], [4, 5]])
  api.updateEditorSearchScope(view, 'capture')
  const { EditorState } = require('@codemirror/state')
  view.state = EditorState.create({ doc: '星 星', extensions: api.createSearchExtensions() })
  api.updateEditorSearch(view, query, true)
  assert.equal(api.getEditorSearchScope(view).enabled, false)
  assert.deepEqual(matchRanges(view), [[0, 1], [2, 3]])
})

test('空選択・複数選択・読取専用では範囲更新を拒否し、既存の限定を維持する', () => {
  const { EditorSelection } = require('@codemirror/state')
  const { view, api } = createScopeView('星 星', {}, { anchor: 0, head: 1 })
  api.updateEditorSearchScope(view, 'capture')
  view.dispatch({ selection: { anchor: 2 } })
  assert.equal(api.updateEditorSearchScope(view, 'capture'), false)
  assert.match(api.getEditorSearchScope(view).reason, /選択/)
  view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(2, 3)]) })
  assert.equal(api.updateEditorSearchScope(view, 'capture'), false)
  assert.match(api.getEditorSearchScope(view).reason, /複数/)
  assert.deepEqual(matchRanges(view), [[0, 1]])
  const locked = createScopeView('星', {}, { anchor: 0, head: 1 }, true)
  assert.equal(locked.api.updateEditorSearchScope(locked.view, 'capture'), false)
  assert.equal(locked.api.updateEditorSearchScope(locked.view, 'clear'), false)
})

test('本文変更へ境界を追従させ、両端の挿入と全削除後のUndo／Redoを扱う', () => {
  const { undo, redo } = require('@codemirror/commands')
  const { view, api } = createScopeView('外星外', {}, { anchor: 1, head: 2 })
  api.updateEditorSearchScope(view, 'capture')
  view.dispatch({ changes: [{ from: 1, insert: '星' }, { from: 2, insert: '星' }] })
  assert.deepEqual(matchRanges(view), [[1, 2], [2, 3], [3, 4]])
  undo(view)
  assert.deepEqual(matchRanges(view), [[1, 2]])
  redo(view)
  assert.deepEqual(matchRanges(view), [[1, 2], [2, 3], [3, 4]])

  const deleted = createScopeView('星\n星\n星', {}, { anchor: 2, head: 3 })
  deleted.api.updateEditorSearchScope(deleted.view, 'capture')
  deleted.view.dispatch({ changes: { from: 2, to: 3 } })
  assert.equal(deleted.api.getEditorSearchScope(deleted.view).enabled, true)
  assert.equal(deleted.api.getEditorSearchScope(deleted.view).empty, true)
  assert.equal(deleted.api.getEditorSearchStatus(deleted.view), 'notFound')
  deleted.api.runEditorSearchAction(deleted.view, 'replaceAll')
  assert.equal(deleted.view.state.doc.toString(), '星\n\n星')
  undo(deleted.view)
  assert.equal(deleted.api.getEditorSearchScope(deleted.view).empty, false)
  assert.deepEqual(matchRanges(deleted.view), [[2, 3]])
  redo(deleted.view)
  assert.deepEqual(matchRanges(deleted.view), [])
})

test('範囲をまたぐ一致を除外し、全文の行頭・行末・先読みと複数行の意味を維持する', () => {
  for (const [search, regexp, expected] of [
    ['abc', false, []], ['^bc', true, []], ['bc$', true, []],
    ['bc(?=d)', true, [[1, 3]]], ['b\\nc', true, []],
  ]) {
    const { view, api } = createScopeView('abcd', { search, regexp }, { anchor: 1, head: 3 })
    api.updateEditorSearchScope(view, 'capture')
    assert.deepEqual(matchRanges(view), expected)
  }
  const { view, api } = createScopeView('外\n星\n月\n外', { search: '星\n月' }, { anchor: 2, head: 5 })
  api.updateEditorSearchScope(view, 'capture')
  assert.deepEqual(matchRanges(view), [[2, 5]])
})

test('限定内の正規表現キャプチャとゼロ幅一致を置換し、Undo／Redoで本文を復元する', () => {
  const { undo, redo } = require('@codemirror/commands')
  const { view, api } = createScopeView('第1章\n第2章\n第3章', { search: '第(\\d+)章', replace: 'Chapter $1', regexp: true }, { anchor: 4, head: 7 })
  api.updateEditorSearchScope(view, 'capture')
  api.runEditorSearchAction(view, 'replaceAll')
  assert.equal(view.state.doc.toString(), '第1章\nChapter 2\n第3章')
  undo(view)
  assert.equal(view.state.doc.toString(), '第1章\n第2章\n第3章')
  redo(view)
  assert.equal(view.state.doc.toString(), '第1章\nChapter 2\n第3章')
  const zero = createScopeView('一\n二\n三', { search: '^|$', replace: '!', regexp: true }, { anchor: 2, head: 3 })
  zero.api.updateEditorSearchScope(zero.view, 'capture')
  zero.api.runEditorSearchAction(zero.view, 'replaceAll')
  assert.equal(zero.view.state.doc.toString(), '一\n!二!\n三')
})

test('5万行の文書で限定内の一致を探し、範囲設定では本文・選択・Undo履歴を変えない', () => {
  const { undoDepth } = require('@codemirror/commands')
  const text = '星\n'.repeat(50000)
  const { view, api } = createScopeView(text, {}, { anchor: 80000, head: 80005 })
  const selection = view.state.selection
  api.updateEditorSearchScope(view, 'capture')
  assert.equal(view.state.doc.toString(), text)
  assert.equal(view.state.selection, selection)
  assert.equal(undoDepth(view.state), 0)
  assert.deepEqual(matchRanges(view), [[80000, 80001], [80002, 80003], [80004, 80005]])
  api.runEditorSearchAction(view, 'previous')
  assert.equal(view.state.selection.main.from, 80004)
})

test('範囲変更要求にもセッション・連番・文書世代・ロックの検証を適用する', () => {
  const { SearchSession, createSearchConditions } = loadSourceModule('src/searchSession.ts')
  const session = new SearchSession()
  session.start('search-window')
  session.setLocked(false)
  const command = { type: 'scope', sessionId: 'search-window', sequence: 1,
    documentRevision: session.documentRevision, conditions: createSearchConditions(), scopeAction: 'capture' }
  assert.equal(session.receive(command).scopeAction, 'capture')
  assert.equal(session.receive(command).accepted, false)
  session.setLocked(true)
  assert.equal(session.receive({ ...command, sequence: 2 }).scopeAction, undefined)
  session.setLocked(false)
  assert.equal(session.receive({ ...command, sequence: 3 }).scopeAction, undefined)
  assert.equal(session.receive({ ...command, sequence: 4, documentRevision: session.documentRevision, scopeAction: 'clear' }).scopeAction, 'clear')
  session.stop()
  assert.equal(session.receive({ ...command, sequence: 5 }).accepted, false)
  session.start('new-window')
  assert.equal(session.receive({ ...command, sequence: 6 }).accepted, false)
})
