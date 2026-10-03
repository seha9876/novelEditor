/** 検索・置換の動作を検証する。 */
import { URL } from 'node:url'
import {
  assert,
  deferred,
  loadSourceModule,
  require,
  test,
} from './test-support.mjs'

/** DOM以外は本物のCodeMirror状態を使い、検索・置換・履歴の結合を確認する。 */
function createSearchView(text, query, readOnly = false) {
  const { EditorState, Transaction } = require('@codemirror/state')
  const { history } = require('@codemirror/commands')
  const { SearchQuery, setSearchQuery } = require('@codemirror/search')
  const { createSearchExtensions } = loadSourceModule('src/searchPanel.ts')
  const view = {
    state: EditorState.create({ doc: text, extensions: [createSearchExtensions(), history(), EditorState.readOnly.of(readOnly)] }),
    plugin: () => null,
    dispatch: (transaction) => { view.state = transaction instanceof Transaction ? transaction.state : view.state.update(transaction).state },
  }
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ ...query, literal: true })) })
  return view
}

test('通常検索・日本語・複数行・大小文字・前後の折り返しを処理する', () => {
  const { findNext, findPrevious, getSearchQuery } = require('@codemirror/search')
  const view = createSearchView('星\nStar star\n星', { search: '星' })
  findNext(view)
  assert.equal(view.state.selection.main.from, 0)
  findNext(view)
  assert.equal(view.state.selection.main.from, 12)
  findNext(view)
  assert.equal(view.state.selection.main.from, 0)
  findPrevious(view)
  assert.equal(view.state.selection.main.from, 12)
  for (const [query, expected] of [
    [{ search: 'Star' }, 2], [{ search: 'Star', caseSensitive: true }, 1],
    [{ search: '星\nStar' }, 1], [{ search: '該当なし' }, 0],
  ]) {
    const candidate = createSearchView('星\nStar star\n星', query)
    assert.equal(Array.from(getSearchQuery(candidate.state).getCursor(candidate.state)).length, expected)
  }
  assert.equal(getSearchQuery(createSearchView('星', { search: '[', regexp: true }).state).valid, false)
})

test('正規表現のキャプチャ・ゼロ幅一致・1件置換・全置換をUndo/Redoできる', () => {
  const { replaceAll, findNext, replaceNext } = require('@codemirror/search')
  const { undo, redo } = require('@codemirror/commands')
  const original = '第1章\n第2章'
  const view = createSearchView(original, { search: '第(\\d+)章', replace: 'Chapter $1', regexp: true })
  assert.equal(replaceAll(view), true)
  assert.equal(view.state.doc.toString(), 'Chapter 1\nChapter 2')
  assert.equal(undo(view), true)
  assert.equal(view.state.doc.toString(), original)
  assert.equal(redo(view), true)
  assert.equal(view.state.doc.toString(), 'Chapter 1\nChapter 2')
  const single = createSearchView('星 星', { search: '星', replace: '月' })
  findNext(single)
  replaceNext(single)
  assert.equal(single.state.doc.toString(), '月 星')
  undo(single)
  assert.equal(single.state.doc.toString(), '星 星')
  const zeroWidth = createSearchView('一\n二', { search: '^', replace: '　', regexp: true })
  replaceAll(zeroWidth)
  assert.equal(zeroWidth.state.doc.toString(), '　一\n　二')
  const locked = createSearchView('星', { search: '星', replace: '月' }, true)
  assert.equal(replaceAll(locked), false)
  assert.equal(locked.state.doc.toString(), '星')
})

test('別窓の操作には最新条件を同封し、遅着した入力や重複操作で条件と本文を戻さない', () => {
  const { SearchSession, createSearchConditions } = loadSourceModule('src/searchSession.ts')
  const { updateEditorSearch, runEditorSearchAction } = loadSourceModule('src/searchPanel.ts')
  const session = new SearchSession()
  session.start('first-window')
  session.setLocked(false)
  const view = createSearchView('星 月 星', { search: '星' })
  const command = {
    type: 'action', sessionId: 'first-window', sequence: 2,
    documentRevision: session.documentRevision,
    conditions: { ...createSearchConditions(), search: '月', replace: '太陽' }, action: 'replaceAll',
  }
  const result = session.receive(command)
  updateEditorSearch(view, session.conditions, true)
  runEditorSearchAction(view, result.action)
  assert.equal(view.state.doc.toString(), '星 太陽 星')
  assert.equal(session.receive({ ...command, type: 'change', sequence: 1, conditions: { ...command.conditions, search: '星' } }).accepted, false)
  assert.equal(session.receive(command).accepted, false)
  assert.equal(session.conditions.search, '月')
  command.conditions.search = '送信後の変更'
  assert.equal(session.conditions.search, '月')
})

test('文書切替や確認ダイアログをまたいだ遅延要求と、閉じた窓の要求を実行しない', () => {
  const { SearchSession, createSearchConditions } = loadSourceModule('src/searchSession.ts')
  const session = new SearchSession()
  session.start('first-window')
  session.setLocked(false)
  const command = {
    type: 'action', sessionId: 'first-window', sequence: 1,
    documentRevision: session.documentRevision,
    conditions: { ...createSearchConditions(), search: '星', replace: '月' }, action: 'replaceAll',
  }
  session.setLocked(true)
  assert.equal(session.receive(command).action, undefined)
  session.setLocked(false)
  assert.equal(session.receive({ ...command, sequence: 2 }).action, undefined)
  assert.equal(session.receive({ ...command, sequence: 3, documentRevision: session.documentRevision }).action, 'replaceAll')
  session.stop()
  assert.equal(session.receive({ ...command, sequence: 4 }).accepted, false)
  session.start('second-window')
  assert.equal(session.conditions.search, '星')
  assert.equal(session.receive({ ...command, sequence: 5 }).accepted, false)
  assert.equal(session.receive({ ...command, sessionId: 'second-window', sequence: 1, documentRevision: session.documentRevision }).action, 'replaceAll')
})

test('閉じる直前の条件を保持し、読み込み完了前の閉じる操作では既存条件を失わない', () => {
  const { SearchSession, createSearchConditions } = loadSourceModule('src/searchSession.ts')
  const session = new SearchSession()
  session.start('first-window')
  session.receive({ type: 'close', sessionId: 'first-window', sequence: 1, documentRevision: 0,
    conditions: { ...createSearchConditions(), search: '最後の入力\n次の行', regexp: true } })
  session.stop()
  session.start('second-window')
  session.receive({ type: 'close', sessionId: 'second-window', sequence: 1, documentRevision: -1 })
  assert.equal(session.conditions.search, '最後の入力\n次の行')
  assert.equal(session.conditions.regexp, true)
})

test('外部検索の条件とハイライトを新文書へ適用し、結果更新・ロック・Undoを統合する', () => {
  const { updateEditorSearch, runEditorSearchAction, getEditorSearchStatus } = loadSourceModule('src/searchPanel.ts')
  const { searchPanelOpen } = require('@codemirror/search')
  const { undo } = require('@codemirror/commands')
  const conditions = { search: '星\n月', replace: '朝', caseSensitive: false, regexp: false }
  const view = createSearchView('星\n月', { search: '' })
  updateEditorSearch(view, conditions, true)
  assert.equal(searchPanelOpen(view.state), true)
  assert.equal(getEditorSearchStatus(view), 'found')
  runEditorSearchAction(view, 'replaceAll')
  assert.equal(view.state.doc.toString(), '朝')
  assert.equal(getEditorSearchStatus(view), 'notFound')
  assert.equal(undo(view), true)
  assert.equal(view.state.doc.toString(), '星\n月')
  // EditorPaneと同じく文書ごとに状態を作り直し、検索条件だけを引き継ぐ。
  view.state = createSearchView('新しい章\n星\n月', { search: '' }).state
  updateEditorSearch(view, conditions, true)
  assert.equal(undo(view), false)
  assert.equal(getEditorSearchStatus(view), 'found')
  updateEditorSearch(view, { ...conditions, search: '[', regexp: true }, true)
  assert.equal(getEditorSearchStatus(view), 'invalid')
  runEditorSearchAction(view, 'replaceAll')
  assert.equal(view.state.doc.toString(), '新しい章\n星\n月')
  updateEditorSearch(view, conditions, false)
  assert.equal(searchPanelOpen(view.state), false)
  assert.equal(getEditorSearchStatus(view), 'found')
  const locked = createSearchView('星 星', { search: '星', replace: '月' }, true)
  const before = locked.state.selection.main
  runEditorSearchAction(locked, 'next')
  runEditorSearchAction(locked, 'replaceAll')
  assert.equal(locked.state.selection.main, before)
  assert.equal(locked.state.doc.toString(), '星 星')
})

test('検索Controllerは購読待ちの破棄後に遅着unlistenを即時実行する', async () => {
  const listenDeferred = deferred()
  let unlistenCount = 0
  const { ref } = require('vue')
  const controllerModule = loadSourceModule('src/useSearchController.ts', {
    '@tauri-apps/api/event': {
      async emitTo() {},
      async listen() { return listenDeferred.promise },
    },
    '@tauri-apps/api/webviewWindow': {
      WebviewWindow: class {},
    },
  })
  const controller = controllerModule.useSearchController({
    editor: ref(null),
    documentLocked: ref(false),
    mainCloseInProgress: ref(false),
    appWindow: { setFocus: async () => {} },
    showPersistenceNotice: () => {},
    showError: async () => {},
  })

  const setup = controller.setup()
  await controller.dispose()
  listenDeferred.release(() => { unlistenCount += 1 })
  await setup
  assert.equal(unlistenCount, 1)
})

test('検索窓の破棄後に遅着した生成エラーを通知しない', async () => {
  const { ref } = require('vue')
  const callbacks = {}
  let errorCount = 0
  class MockWebviewWindow {
    constructor() {}
    once(event, callback) {
      callbacks[event] = callback
      return Promise.resolve(() => {})
    }
    destroy() { return Promise.resolve() }
    async unminimize() {}
    async setFocus() {}
  }
  const controllerModule = loadSourceModule('src/useSearchController.ts', {
    '@tauri-apps/api/event': {
      async emitTo() {},
      async listen() { return () => {} },
    },
    '@tauri-apps/api/webviewWindow': { WebviewWindow: MockWebviewWindow },
  })
  const controller = controllerModule.useSearchController({
    editor: ref(null),
    documentLocked: ref(false),
    mainCloseInProgress: ref(false),
    appWindow: { setFocus: async () => {} },
    showPersistenceNotice: () => {},
    showError: async () => { errorCount += 1 },
  })

  await controller.open('search')
  await controller.dispose()
  callbacks['tauri://error']({ payload: '破棄後の遅着エラー' })
  assert.equal(errorCount, 0)
})

/** 実Controllerへ検索窓とイベント境界を接続し、窓世代の競合を再現する。 */
function createSearchControllerHarness({ locked = false, focusPromise = Promise.resolve(), editorAdapter } = {}) {
  const { ref } = require('vue')
  const windows = []
  const snapshots = []
  const actions = []
  const errors = []
  const documentLocked = ref(locked)
  const { createSearchScopeStatus } = loadSourceModule('src/searchSession.ts')
  let commandListener
  let editorFocusCount = 0
  class MockSearchWindow {
    constructor(_label, options) {
      this.callbacks = {}
      this.sessionId = new URL(options.url, 'http://localhost').searchParams.get('session')
      windows.push(this)
    }
    async once(event, callback) { this.callbacks[event] = callback; return () => {} }
    async destroy() {}
    async unminimize() {}
    async setFocus() {}
  }
  const { useSearchController } = loadSourceModule('src/useSearchController.ts', {
    '@tauri-apps/api/event': {
      async listen(_event, listener) { commandListener = listener; return () => {} },
      async emitTo(_target, _event, snapshot) { snapshots.push(snapshot) },
    },
    '@tauri-apps/api/webviewWindow': { WebviewWindow: MockSearchWindow },
  })
  const controller = useSearchController({
    editor: ref(editorAdapter ?? { setSearch() {}, runSearch(action) { actions.push(action) }, focus() { editorFocusCount += 1 },
      getSearchScope: createSearchScopeStatus, setSearchScope: () => false }),
    documentLocked, mainCloseInProgress: ref(false),
    appWindow: { setFocus: () => focusPromise },
    showPersistenceNotice: (error) => errors.push(error), showError: async (...error) => { errors.push(error) },
  })
  return { controller, windows, snapshots, actions, errors, documentLocked,
    send: (command) => commandListener({ payload: command }),
    focusCount: () => editorFocusCount }
}

test('検索Controllerは初期ロック状態を同期し、最初の操作から正しく検索できる', async () => {
  for (const locked of [false, true]) {
    const harness = createSearchControllerHarness({ locked })
    await harness.controller.setup()
    if (locked) {
      await harness.controller.open('search')
      assert.equal(harness.windows.length, 0)
    } else {
      await harness.controller.open('search')
      const sessionId = harness.windows[0].sessionId
      harness.send({ type: 'ready', sessionId })
      const snapshot = harness.snapshots.at(-1)
      assert.equal(snapshot.locked, false)
      harness.send({ type: 'action', sessionId, sequence: 1, documentRevision: snapshot.documentRevision,
        conditions: { search: '星', replace: '', caseSensitive: false, regexp: false }, action: 'next' })
      assert.deepEqual(harness.actions, ['next'])
    }
    await harness.controller.dispose()
  }
})

test('検索窓を再作成した後の旧窓の生成通知・エラーで新窓を壊さない', async () => {
  const harness = createSearchControllerHarness()
  await harness.controller.setup()
  await harness.controller.open('search')
  const oldWindow = harness.windows[0]
  await harness.controller.close()
  await harness.controller.open('search')
  const newWindow = harness.windows[1]
  oldWindow.callbacks['tauri://created']()
  oldWindow.callbacks['tauri://error']({ payload: '旧窓の遅着エラー' })
  harness.send({ type: 'ready', sessionId: newWindow.sessionId })
  assert.equal(harness.snapshots.at(-1).sessionId, newWindow.sessionId)
  assert.deepEqual(harness.errors, [])
  await harness.controller.dispose()
})

test('検索終了後の非同期フォーカスが再表示や破棄後に本文へフォーカスを奪わない', async () => {
  for (const reopen of [false, true]) {
    const focus = deferred()
    const harness = createSearchControllerHarness({ focusPromise: focus.promise })
    await harness.controller.open('search')
    await harness.controller.close()
    if (reopen) await harness.controller.open('search')
    else await harness.controller.dispose()
    focus.release()
    await Promise.resolve()
    assert.equal(harness.focusCount(), 0)
    await harness.controller.dispose()
  }
})

/** 範囲付きの本物のCodeMirror状態を検索Controllerへ接続する。 */
function createScopedControllerHarness() {
  const core = loadSourceModule('src/searchPanel.ts')
  const { EditorState, Transaction } = require('@codemirror/state')
  const { history } = require('@codemirror/commands')
  let harness
  const view = {
    state: EditorState.create({ doc: '星 星 星', selection: { anchor: 2, head: 3 }, extensions: [core.createSearchExtensions(), history()] }),
    plugin: () => null,
    dispatch(transaction) {
      view.state = transaction instanceof Transaction ? transaction.state : view.state.update(transaction).state
      harness?.controller.onScope(core.getEditorSearchScope(view))
      harness?.controller.onStatus(core.getEditorSearchStatus(view))
    },
  }
  harness = createSearchControllerHarness({ editorAdapter: {
    setSearch: (conditions, active) => core.updateEditorSearch(view, conditions, active),
    runSearch: (action) => core.runEditorSearchAction(view, action),
    getSearchScope: () => core.getEditorSearchScope(view),
    setSearchScope: (action) => core.updateEditorSearchScope(view, action),
    focus() {},
  } })
  return { ...harness, core, view }
}

test('限定範囲を検索窓の再表示とF3へ引き継ぎ、本文とパスを子窓へ送らない', async () => {
  const harness = createScopedControllerHarness()
  const { controller, view } = harness
  await controller.setup()
  await controller.open('search')
  const sessionId = harness.windows[0].sessionId
  harness.send({ type: 'ready', sessionId })
  const command = { sessionId, sequence: 1, documentRevision: harness.snapshots.at(-1).documentRevision,
    conditions: { search: '星', replace: '月', regexp: false, caseSensitive: false } }
  harness.send({ ...command, type: 'scope', scopeAction: 'capture' })
  assert.equal(controller.searchScope.value.enabled, true)
  harness.send({ ...command, sequence: 2, type: 'action', action: 'replaceAll' })
  assert.equal(view.state.doc.toString(), '星 月 星')
  await controller.close()
  assert.equal(controller.searchScope.value.enabled, true)
  view.dispatch({ selection: { anchor: 0 } })
  controller.onNavigate('next')
  assert.equal(view.state.selection.main.head, 0, '範囲外の星には移動しない')
  await controller.open('search')
  harness.send({ type: 'ready', sessionId: harness.windows[1].sessionId })
  const snapshot = harness.snapshots.at(-1)
  assert.equal(snapshot.scope.enabled, true)
  assert.deepEqual(Object.keys(snapshot.scope).sort(), ['canCapture', 'empty', 'enabled', 'endLine', 'reason', 'startLine'])
  assert.equal('text' in snapshot, false)
  assert.equal('path' in snapshot, false)
  await controller.dispose()
})

test('限定解除の遅着・重複を拒否し、保存相当のロックや取消で範囲を失わない', async () => {
  const harness = createScopedControllerHarness()
  await harness.controller.setup()
  await harness.controller.open('search')
  const sessionId = harness.windows[0].sessionId
  harness.send({ type: 'ready', sessionId })
  const command = { type: 'scope', scopeAction: 'capture', sessionId, sequence: 1,
    documentRevision: harness.snapshots.at(-1).documentRevision,
    conditions: { search: '星', replace: '月', regexp: false, caseSensitive: false } }
  harness.send(command)
  harness.documentLocked.value = true
  harness.send({ ...command, sequence: 2, scopeAction: 'clear' })
  harness.documentLocked.value = false
  harness.send({ ...command, sequence: 3, scopeAction: 'clear' })
  assert.equal(harness.core.getEditorSearchScope(harness.view).enabled, true)
  harness.send({ ...command, sequence: 3, scopeAction: 'clear', documentRevision: harness.snapshots.at(-1).documentRevision })
  assert.equal(harness.core.getEditorSearchScope(harness.view).enabled, true)
  harness.send({ ...command, sequence: 4, scopeAction: 'clear', documentRevision: harness.snapshots.at(-1).documentRevision })
  assert.equal(harness.core.getEditorSearchScope(harness.view).enabled, false)
  harness.view.dispatch({ selection: { anchor: 0 } })
  harness.send({ ...command, sequence: 5, documentRevision: harness.snapshots.at(-1).documentRevision })
  assert.match(harness.snapshots.at(-1).error, /選択/)
  assert.equal(harness.core.getEditorSearchScope(harness.view).enabled, false)
  await harness.controller.dispose()
})
