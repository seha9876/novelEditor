/** 文書検索・置換と書記素統計、非同期Workerのライフサイクルを検証する。 */
import {
  assert,
  deferred,
  loadSourceModule,
  readFileSync,
  projectRoot,
  require,
  resolve,
  test,
} from './test-support.mjs'

test('ショートカットはShiftとIME入力を正確に区別する', () => {
  const { findShortcutCommand } = loadSourceModule('src/appCommands.ts')
  const base = { key: 's', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }
  assert.equal(findShortcutCommand(base)?.id, 'document.save')
  assert.equal(findShortcutCommand({ ...base, key: 'S', shiftKey: true })?.id, 'document.saveAs')
  assert.equal(findShortcutCommand({ ...base, key: 'f' })?.id, 'edit.find')
  assert.equal(findShortcutCommand({ ...base, key: 'h' })?.id, 'edit.replace')
  assert.equal(findShortcutCommand({ ...base, altKey: true }), undefined)
  assert.equal(findShortcutCommand({ ...base, metaKey: true }), undefined)
  assert.equal(findShortcutCommand({ ...base, isComposing: true }), undefined)
})

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

test('書記素計数は結合文字・異体字・絵文字を1文字として扱い、改行と空白を区別する', () => {
  const { countText } = loadSourceModule('src/textStatistics.ts')
  for (const text of ['', '星', 'か\u3099', 'e\u0301', '葛\u{E0100}', '👍🏽', '🇯🇵', '👨‍👩‍👧‍👦']) {
    const expected = text ? 1 : 0
    assert.deepEqual(countText(text), { characters: expected, withoutWhitespace: expected })
  }
  assert.deepEqual(countText('星 月\t　\u00a0\r\n空\n\r'), { characters: 7, withoutWhitespace: 3 })
  assert.deepEqual(countText('か\n\u3099'), { characters: 2, withoutWhitespace: 2 })
  assert.deepEqual(countText('\r\n\r\n\u0085\u2028\u2029'), { characters: 0, withoutWhitespace: 0 })
  const original = 'か\u3099'
  countText(original)
  assert.equal(original, 'か\u3099')
})

test('現在列は書記素単位とし、書記素内部・タブ・行末も正しく扱う', () => {
  const { countColumn } = loadSourceModule('src/textStatistics.ts')
  const text = 'か\u3099😀\t星'
  assert.deepEqual(Array.from({ length: text.length + 1 }, (_, offset) => countColumn(text, offset)), [1, 1, 2, 2, 3, 4, 5])
  assert.equal(countColumn('', 0), 1)
  assert.equal(countColumn('🇯🇵🇺🇸', 3), 1)
  assert.equal(countColumn('🇯🇵🇺🇸', 4), 2)
})

test('選択は非空範囲を個別に合算し、全文確定値なしでも独立に計算できる', () => {
  const { EditorState, EditorSelection } = require('@codemirror/state')
  const { calculateStatistics } = loadSourceModule('src/editorStatistics.ts')
  const state = EditorState.create({
    doc: 'か\u3099\n星　月\n👍🏽',
    selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(1, 2), EditorSelection.cursor(3), EditorSelection.range(3, 6), EditorSelection.range(9, 11)]),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  })
  const ranges = state.selection.ranges.filter((range) => !range.empty).map((range) => state.doc.sliceString(range.from, range.to))
  const result = calculateStatistics({ documentId: 1, selectionId: 2, selection: { ranges, line: 'か\u3099', offset: 1, lineNumber: 1, lineCount: 3 } })
  assert.equal(result.document, undefined)
  assert.deepEqual(result.selection, { characters: 6, withoutWhitespace: 5 })
  assert.equal(result.column, 1)
  const empty = calculateStatistics({ documentId: 1, selectionId: 3, text: '', selection: { ranges: [], line: '', offset: 0, lineNumber: 1, lineCount: 1 } })
  assert.deepEqual(empty.document, { characters: 0, withoutWhitespace: 0 })
  assert.deepEqual(empty.selection, { characters: 0, withoutWhitespace: 0 })
})

/** Worker境界だけを手動応答にし、実際の予約処理と純粋な計数処理を接続する。 */
function createStatisticsHarness() {
  const { StatisticsController, calculateStatistics } = loadSourceModule('src/editorStatistics.ts')
  const requests = []
  const states = []
  const worker = { postMessage: (request) => requests.push(request), terminate: () => { worker.terminated = true } }
  const controller = new StatisticsController(worker, (state) => states.push(state))
  return {
    controller, worker, requests, states,
    selection: (ranges = [], line = '', offset = 0) => ({ ranges, line, offset, lineNumber: 1, lineCount: 1 }),
    respond: (index) => worker.onmessage({ data: calculateStatistics(requests[index]) }),
  }
}

test('全文要求を250msでまとめ、処理中も最新1件だけを残す', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const h = createStatisticsHarness()
  h.controller.updateDocument('星', h.selection())
  context.mock.timers.tick(249)
  assert.equal(h.requests.length, 0)
  h.controller.updateDocument('星月', h.selection())
  context.mock.timers.tick(250)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].text, '星月')
  h.controller.updateDocument('星月空', h.selection())
  h.controller.updateDocument('星月空海', h.selection())
  context.mock.timers.tick(250)
  assert.equal(h.requests.length, 1)
  h.respond(0)
  assert.equal(h.states.at(-1).document, null)
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].text, '星月空海')
  h.respond(1)
  assert.deepEqual(h.states.at(-1).document, { characters: 4, withoutWhitespace: 4 })
  assert.equal(h.states.at(-1).pending, false)
  h.controller.dispose()
})

test('カーソル移動では全文結果を再利用し、遅い選択結果だけを無視する', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const h = createStatisticsHarness()
  h.controller.updateDocument('星月', h.selection([], '星月', 0))
  context.mock.timers.tick(250)
  h.controller.updateSelection(h.selection(['星'], '星月', 1))
  h.controller.updateSelection(h.selection(['星月'], '星月', 2))
  h.respond(0)
  assert.deepEqual(h.states.at(-1).document, { characters: 2, withoutWhitespace: 2 })
  assert.equal(h.states.at(-1).selection, null)
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].text, undefined)
  h.respond(1)
  assert.deepEqual(h.states.at(-1).selection, { characters: 2, withoutWhitespace: 2 })
  assert.equal(h.states.at(-1).column, 3)
  assert.equal(h.states.at(-1).pending, false)
  h.controller.updateSelection(h.selection())
  assert.equal(h.requests[2].text, undefined)
  h.controller.dispose()
})

test('文書切替は前文書の統計と遅延応答を残さず、破棄後は通知しない', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const h = createStatisticsHarness()
  h.controller.updateDocument('第一章', h.selection())
  context.mock.timers.tick(250)
  h.respond(0)
  h.controller.updateSelection(h.selection(['第一章']))
  h.controller.updateDocument('次', h.selection(), true)
  assert.equal(h.states.at(-1).document, null)
  h.respond(1)
  assert.equal(h.states.at(-1).document, null)
  context.mock.timers.tick(250)
  h.respond(2)
  assert.equal(h.states.at(-1).document.characters, 1)
  const size = h.states.length
  h.controller.dispose()
  h.respond(0)
  assert.equal(h.states.length, size)
  assert.equal(h.worker.terminated, true)
})

test('Worker失敗を統計エラーとして通知し、無限再試行しない', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const h = createStatisticsHarness()
  h.controller.updateDocument('星', h.selection())
  h.worker.onerror({ preventDefault() {} })
  assert.equal(h.states.at(-1).pending, false)
  assert.match(h.states.at(-1).error, /集計に失敗/)
  h.controller.updateDocument('星月', h.selection())
  context.mock.timers.tick(1000)
  assert.equal(h.requests.length, 0)
  assert.equal(h.worker.terminated, true)
})

test('集計失敗後の文書切替は旧確定値を消し、画面破棄後はエラーも通知しない', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const h = createStatisticsHarness()
  h.controller.updateDocument('第一章', h.selection(['第一章'], '第一章', 3))
  context.mock.timers.tick(250)
  h.respond(0)
  assert.equal(h.states.at(-1).document.characters, 3)
  assert.equal(h.states.at(-1).selection.characters, 3)
  assert.equal(h.states.at(-1).column, 4)
  h.worker.onerror({ preventDefault() {} })
  const error = h.states.at(-1).error
  const nextSelection = { ranges: ['新', '本文'], line: '本文', offset: 1, lineNumber: 2, lineCount: 3 }
  h.controller.updateDocument('新\n本文\n', nextSelection, true)
  assert.deepEqual(h.states.at(-1), {
    document: null, selection: null, column: null, selectionRanges: 2,
    line: 2, lineCount: 3, pending: false, error,
  })
  h.controller.updateSelection({ ...nextSelection, ranges: [], lineNumber: 3 })
  assert.equal(h.states.at(-1).selectionRanges, 0)
  assert.equal(h.states.at(-1).line, 3)
  assert.equal(h.states.at(-1).error, error)
  context.mock.timers.tick(1000)
  assert.equal(h.requests.length, 1)
  h.respond(0)
  assert.equal(h.states.at(-1).document, null)
  const notifications = h.states.length
  h.controller.dispose()
  h.controller.updateDocument('破棄後', nextSelection, true)
  h.controller.updateSelection(nextSelection)
  h.worker.onerror({ preventDefault() {} })
  h.worker.onmessageerror()
  h.respond(0)
  assert.equal(h.states.length, notifications)
})

test('本文セッションは入力基準、表示名、文書出自を一つの状態として更新する', () => {
  const { ref } = require('vue')
  const documentApi = loadSourceModule('src/useDocumentSession.ts', {
    '@tauri-apps/plugin-dialog': { ask: async () => true, open: async () => null, save: async () => null },
    '@tauri-apps/api/core': { invoke: async () => ({ projects: [], nodes: [], activeProjectId: null }) },
    '@tauri-apps/plugin-fs': { exists: async () => false, readFile: async () => new Uint8Array(), writeFile: async () => {} },
    '@tauri-apps/plugin-store': { load: async () => ({}) },
  })
  const text = { value: '' }
  const editor = ref({
    getText: () => text.value,
    setDocument: (next) => { text.value = next },
    focus() {},
    setSearch() {},
    runSearch() {},
  })
  const closeState = ref(false)
  const results = []
  const session = documentApi.useDocumentSession({
    editor,
    mainCloseInProgress: closeState,
    showPersistenceNotice: () => {},
    showError: async () => {},
    reportProjectTreeOpenResult: (result) => results.push(result),
  })

  assert.equal(session.displayName.value, '無題')
  session.onChange('本文')
  assert.equal(session.dirty.value, true)
  session.onChange('')
  assert.equal(session.dirty.value, false)
  session.detachDocumentOrigin(10)
  assert.equal(session.documentOrigin.value, null)
  assert.deepEqual(results, [])
  session.dispose()
})

test('本文セッションは復旧await中の破棄後に本文やフォーカスを更新しない', async () => {
  const { ref } = require('vue')
  const recoveryDeferred = deferred()
  let focusCount = 0
  const documentApi = loadSourceModule('src/useDocumentSession.ts', {
    './recoveryStore': {
      loadRecoverySnapshot: () => recoveryDeferred.promise,
      saveRecoverySnapshot: async () => {},
    },
    '@tauri-apps/plugin-dialog': { ask: async () => true, open: async () => null, save: async () => null },
    '@tauri-apps/api/core': { invoke: async () => ({ projects: [], nodes: [], activeProjectId: null }) },
    '@tauri-apps/plugin-fs': { exists: async () => false, readFile: async () => new Uint8Array(), writeFile: async () => {} },
    '@tauri-apps/plugin-store': { load: async () => ({}) },
  })
  const editor = ref({
    getText: () => '',
    setDocument() {},
    focus() { focusCount += 1 },
    setSearch() {},
    runSearch() {},
  })
  const session = documentApi.useDocumentSession({
    editor,
    mainCloseInProgress: ref(false),
    showPersistenceNotice: () => {},
    showError: async () => {},
    reportProjectTreeOpenResult: () => {},
  })

  const initialize = session.initializeRecovery()
  session.dispose()
  recoveryDeferred.release({
    schemaVersion: 1,
    text: '遅着本文',
    fileName: '遅着.txt',
    lineEnding: '\n',
    hasBom: false,
    updatedAt: new Date().toISOString(),
  })
  assert.equal(await initialize, false)
  assert.equal(editor.value.getText(), '')
  assert.equal(focusCount, 0)
  assert.equal(session.busy.value, true)
  assert.equal(session.documentLocked.value, true)
})

test('メイン画面の初期化は破棄後に遅着awaitを継続しない', () => {
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  assert.match(app, /let appLifecycleGeneration = 0/)
  assert.match(app, /function isAppLifecycleActive\(generation: number\)/)
  assert.match(app, /await setupMainWindowController\(\)\s*if \(!isAppLifecycleActive\(generation\)\) return/)
  assert.match(app, /appMounted = false\s*appLifecycleGeneration \+= 1\s*window\.removeEventListener/)
})

test('メイン窓Controllerは低レベル終了要求を一度だけ調停へ渡し、表示状態を解除する', async () => {
  const { ref } = require('vue')
  let closeHandler
  let resizeHandler
  let closeUnlistenCount = 0
  let resizeUnlistenCount = 0
  const appWindow = {
    async isMaximized() { return true },
    async isAlwaysOnTop() { return false },
    async onCloseRequested(handler) { closeHandler = handler; return () => { closeUnlistenCount += 1 } },
    async onResized(handler) { resizeHandler = handler; return () => { resizeUnlistenCount += 1 } },
    async close() {},
  }
  const windowApi = {
    getCurrentWindow: () => appWindow,
    currentMonitor: async () => null,
    PhysicalPosition: class {},
    PhysicalSize: class {},
  }
  const controllerModule = loadSourceModule('src/useMainWindowController.ts', {
    '@tauri-apps/api/window': windowApi,
  })
  const closeInProgress = ref(false)
  let closeRequests = 0
  const controller = controllerModule.useMainWindowController({
    mainCloseInProgress: closeInProgress,
    showError: async () => {},
    onCloseRequested: async () => { closeRequests += 1 },
  })

  await controller.setup()
  assert.equal(controller.maximized.value, true)
  assert.equal(controller.alwaysOnTop.value, false)
  let prevented = 0
  await closeHandler({ preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1)
  assert.equal(closeRequests, 1)
  closeInProgress.value = true
  await closeHandler({ preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 2)
  assert.equal(closeRequests, 1)
  resizeHandler()
  controller.dispose()
  assert.equal(closeUnlistenCount, 1)
  assert.equal(resizeUnlistenCount, 1)
})

test('メイン窓Controllerは購読待ちの破棄後に遅着unlistenを解除し、追加購読を作らない', async () => {
  const closeListenDeferred = deferred()
  let closeListenCount = 0
  let resizeListenCount = 0
  let closeUnlistenCount = 0
  const appWindow = {
    async isMaximized() { return false },
    async isAlwaysOnTop() { return false },
    async onCloseRequested() {
      closeListenCount += 1
      return closeListenDeferred.promise
    },
    async onResized() {
      resizeListenCount += 1
      return () => {}
    },
  }
  const controllerModule = loadSourceModule('src/useMainWindowController.ts', {
    '@tauri-apps/api/window': {
      getCurrentWindow: () => appWindow,
      currentMonitor: async () => null,
      PhysicalPosition: class {},
      PhysicalSize: class {},
    },
  })
  const controller = controllerModule.useMainWindowController({
    appWindow,
    mainCloseInProgress: { value: false },
    showError: async () => {},
    onCloseRequested: async () => {},
  })

  const firstSetup = controller.setup()
  const secondSetup = controller.setup()
  controller.dispose()
  closeListenDeferred.release(() => { closeUnlistenCount += 1 })
  await Promise.all([firstSetup, secondSetup])
  assert.equal(closeListenCount, 1)
  assert.equal(closeUnlistenCount, 1)
  assert.equal(resizeListenCount, 0)
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
