/** 統計計算とWorkerControllerのライフサイクルを検証する。 */
import {
  assert,
  loadSourceModule,
  require,
  test,
} from './test-support.mjs'

/** Worker境界だけを手動応答にし、実際の予約処理と純粋な計数処理を接続する。 */
function createStatisticsHarness() {
  const { StatisticsController } = loadSourceModule('src/editorStatistics.ts')
  const { calculateStatistics } = loadSourceModule('src/statisticsCalculation.ts')
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
  const { calculateStatistics } = loadSourceModule('src/statisticsCalculation.ts')
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
