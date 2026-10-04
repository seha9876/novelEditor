/** 四つのパネルの本文保全、旧設定、解析、非同期取消と簡易履歴を検証する。 */
import { assert, deferred, loadSourceModule, projectRoot, readFileSync, require, resolve, test, ts, TextEncoder } from './test-support.mjs'

const { ref, nextTick } = require('vue')
const outline = loadSourceModule('src/outline.ts')
const analysis = loadSourceModule('src/sidebarAnalysis.ts')

test('標準見出しは単独行と明確な区切りだけを認識し、存在する上位へ接続する', () => {
  const text = 'プロローグ\n第一章ではありません。\n第一部\n第1章 再会\n第２節：翌朝\n第十二話\n1. 本文\n◆装飾\n終章: 帰路'
  const result = outline.extractOutline(text, outline.createDefaultOutline())
  assert.deepEqual(result.map(h => [h.text, h.level, h.parent]), [
    ['プロローグ', 2, null], ['第一部', 1, null], ['第1章 再会', 2, 1], ['第２節：翌朝', 3, 2], ['第十二話', 2, 1], ['終章: 帰路', 2, 1],
  ])
  assert.equal(result[2].from, text.indexOf('第1章'))
  assert.equal(result[2].line, 4)
  assert.equal(outline.extractOutline('第一章\n第一節\n第二章', outline.createDefaultOutline())[0].parent, null)
})

test('作者の行頭・行末・番号・正規表現を優先順で判定し、本文を変更しない', () => {
  const base = { id: 'custom', name: '独自', enabled: true, level: 4, kind: 'affix', prefix: '【', suffix: '】', pattern: '' }
  const prefs = { rules: [base, { ...base, id: 'number', kind: 'numbered', pattern: '場面{番号}', level: 2 }, { ...base, id: 'regex', kind: 'regexp', pattern: '^【.+】$', level: 1 }] }
  const text = '　【再会】　\n場面１０：帰路\n場面一の文章\n普通の本文'
  const found = outline.extractOutline(text, prefs)
  assert.deepEqual(found.map(h => [h.ruleId, h.text]), [['custom', '【再会】'], ['number', '場面１０：帰路']])
  assert.equal(text, '　【再会】　\n場面１０：帰路\n場面一の文章\n普通の本文')
  assert.ok(outline.outlineRuleError({ ...base, kind: 'regexp', pattern: '[' }))
  assert.ok(outline.outlineRuleError({ ...base, kind: 'numbered', pattern: '{番号}{番号}' }))
  assert.ok(outline.outlineRuleError({ ...base, prefix: '', suffix: '' }))
  assert.ok(outline.outlineRuleError({ ...base, level: 7 }))
  const cloned = outline.cloneOutline(prefs); cloned.rules[0].level = 1
  assert.equal(prefs.rules[0].level, 4)
  assert.deepEqual(outline.normalizeOutline({ rules: [] }), { rules: [] })
})

test('旧ツリー設定を移行し、サイドバーの保存はツリー分離と独自ルールを保持する', async () => {
  const schema = loadSourceModule('src/appPreferenceSchema.ts')
  let value = { ui: { projectTree: { width: 371, collapsed: true, detached: true } } }
  const store = { reload: async () => {}, get: async () => value, set: async (_, next) => { value = globalThis.structuredClone(next) }, save: async () => {} }
  const mocks = { './storageLocation': { getStorageFilePath: () => 'preferences.json' }, '@tauri-apps/plugin-fs': { exists: async () => true }, '@tauri-apps/plugin-store': { load: async () => store } }
  const preferences = loadSourceModule('src/appPreferences.ts', mocks)
  const initial = await preferences.initializeApplicationPreferences()
  assert.deepEqual(initial.preferences.ui.sidebar, { width: 371, collapsed: true, activePanel: 'project' })
  await preferences.saveSidebarPreferences({ width: 300, collapsed: false, activePanel: 'outline' }, true)
  const restarted = await loadSourceModule('src/appPreferences.ts', mocks).initializeApplicationPreferences()
  assert.equal(restarted.preferences.ui.projectTree.detached, true)
  assert.deepEqual(restarted.preferences.ui.sidebar, { width: 300, collapsed: false, activePanel: 'outline' })
  assert.deepEqual(restarted.preferences.outline, outline.createDefaultOutline())
  assert.equal(schema.normalizeApplicationPreferences({ ui: { sidebar: { activePanel: 'future' } } }).ui.sidebar.activePanel, 'project')
})

test('検索カーソルの位置・大小文字・複数行・範囲・空一致・上限をCodeMirrorに揃える', () => {
  const conditions = { search: '再会', caseSensitive: false, regexp: false, replace: '' }
  const text = '第一章\n再会と再会\nnext'
  assert.deepEqual(analysis.findTextMatches(text, conditions, 1000, null).matches.map(m => [m.from, m.to, m.line]), [[4, 6, 2], [7, 9, 2]])
  assert.equal(analysis.findTextMatches(text, conditions, 1, null).limited, true)
  assert.equal(analysis.findTextMatches(text, conditions, 1000, { from: 5, to: 9 }).matches.length, 1)
  assert.equal(analysis.findTextMatches(text, conditions, 1000, { from: 4, to: 4 }).matches.length, 0)
  assert.equal(analysis.findTextMatches('Ab aB', { ...conditions, search: 'ab' }, 1000, null).matches.length, 2)
  assert.equal(analysis.findTextMatches('Ab aB', { ...conditions, search: 'ab', caseSensitive: true }, 1000, null).matches.length, 0)
  assert.equal(analysis.findTextMatches('a\nb', { ...conditions, search: 'a\nb' }, 1000, null).matches[0].to, 3)
  assert.equal(analysis.findTextMatches(text, { ...conditions, search: '^', regexp: true }, 1000, null).matches.length, 3)
  assert.throws(() => analysis.findTextMatches(text, { ...conditions, search: '[', regexp: true }, 1000, null))
})

/** 実際の検索Controllerへ読込・Workerの境界だけを差し替える。 */
function searchHarness(t, extra = {}) {
  const active = ref(true), revision = ref(1), path = ref('C:/作品/current.txt'), conditions = ref({ search: '再会', regexp: false, caseSensitive: false, replace: '' })
  const snapshot = ref({ activeProjectId: 1, projects: [{ id: 1, name: '作品' }], nodes: [
    { id: 1, projectId: 1, parentId: null, kind: 'file', name: 'current.txt', path: path.value },
    { id: 2, projectId: 1, parentId: null, kind: 'file', name: 'saved.txt', path: 'C:/作品/saved.txt' },
    { id: 3, projectId: 1, parentId: null, kind: 'file', name: '重複', path: 'c:/作品/SAVED.txt' },
    { id: 4, projectId: 2, parentId: null, kind: 'file', name: '別作品', path: 'C:/else.txt' },
  ] })
  const read = [], navigated = [], highlighted = [], opened = []
  const document = { text: '再会（未保存）', revision: 1, head: 0, scope: null }
  let c
  const module = loadSourceModule('src/useSidebarSearch.ts', {
    './sidebarWorker': { runSidebarAnalysis: extra.analyze ?? (async request => analysis.findTextMatches(request.text, request.conditions, request.limit, request.scope)) },
    './projectTreeClient': { authorizeProjectFile: async id => { read.push(id); return snapshot.value.nodes.find(node => node.id === id)?.path } },
    '@tauri-apps/plugin-fs': { stat: async () => ({ size: extra.size ?? 10 }) },
    './textFile': { loadTextFile: extra.load ?? (async () => ({ text: '保存した再会\r\n', originalBytes: new TextEncoder().encode('保存した再会\r\n') })) },
  })
  c = module.useSidebarSearch({ active, revision, path, conditions, snapshot, disabled: ref(false), editor: ref({ getDocumentSnapshot: () => document, revealRange: target => { navigated.push(target); return target.revision === document.revision }, setSidebarMatches: (rev, ranges) => highlighted.push([rev, ranges]) }), openFile: async request => {
    opened.push(request); c.receiveOpenResult({ requestId: request.requestId, nodeId: request.nodeId, outcome: extra.outcome ?? 'cancelled' })
  } })
  t.after(c.dispose)
  return { c, active, revision, conditions, document, read, navigated, opened, highlighted, snapshot }
}

test('プロジェクト検索は複数登録をまとめ、現在原稿は未保存本文を優先する', async t => {
  const h = searchHarness(t); h.c.scope.value = 'project'; await nextTick(); await h.c.search()
  assert.deepEqual(h.read, [2]); assert.equal(h.c.results.value.length, 2)
  assert.equal(h.c.results.value[0].current, true); assert.equal(h.c.results.value[1].current, false)
  assert.equal(h.c.results.value[1].line, 1)
  await h.c.openMatch(0); assert.equal(h.navigated.length, 1); assert.equal(h.opened.length, 0)
  await h.c.openMatch(1); assert.equal(h.opened.length, 1); assert.equal(h.opened[0].searchFingerprint.length, 64)
  assert.equal(h.navigated.length, 1, '未保存確認の取消では移動しない')
  h.document.revision++; h.revision.value++; await nextTick()
  assert.equal(h.c.stale.value, true); await h.c.openMatch(0); assert.equal(h.navigated.length, 1)
})

test('読込失敗・サイズ上限は部分失敗として表示し、検索不可と該当なしを混同しない', async t => {
  const h = searchHarness(t, { size: 10 * 1024 * 1024 + 1 }); h.c.scope.value = 'project'; await nextTick(); await h.c.search()
  assert.equal(h.c.results.value.length, 1); assert.match(h.c.errors.value[0], /10MiB/); assert.match(h.c.message.value, /検索できません/)
})

test('非表示・中止・文書切替後のWorker応答を結果に反映しない', async t => {
  const waiting = deferred()
  const h = searchHarness(t, { analyze: async request => request.text ? waiting.promise : { matches: [], limited: false } })
  const job = h.c.search(); await nextTick(); h.active.value = false; await nextTick()
  waiting.release({ matches: [{ from: 0, to: 2, line: 1, before: '', match: '再会', after: '' }], limited: false }); await job
  assert.equal(h.c.results.value.length, 0); assert.equal(h.c.pending.value, false)
})

test('登録TXTの読込は同時2件までに抑え、一致の表示は先頭1,000件までにする', async t => {
  let reading = 0, maximum = 0
  const h = searchHarness(t, { load: async () => {
    reading++; maximum = Math.max(maximum, reading); await nextTick(); reading--
    return { text: '再会', originalBytes: new TextEncoder().encode('再会') }
  } })
  for (let id = 5; id < 10; id++) h.snapshot.value.nodes.push({ id, projectId: 1, parentId: null, kind: 'file', name: `${id}.txt`, path: `C:/作品/${id}.txt` })
  h.c.scope.value = 'project'; await nextTick(); await h.c.search()
  assert.equal(maximum, 2)
  const many = searchHarness(t, { load: async () => ({ text: '再会'.repeat(1001), originalBytes: new TextEncoder().encode('再会'.repeat(1001)) }) })
  many.c.scope.value = 'project'; await nextTick(); await many.c.search()
  assert.equal(many.c.results.value.length, 1000); assert.equal(many.c.limited.value, true); assert.equal(many.c.shown.value, 200)
  assert.match(many.c.message.value, /先頭1,000件/)
})

test('サイドバーの共有条件は即座に本文で正規表現を走査せず、通常のF3検索を維持する', async t => {
  const applied = [], navigated = []
  const c = loadSourceModule('src/useSearchController.ts', {
    '@tauri-apps/api/event': { emitTo: async () => {}, listen: async () => () => {} },
    '@tauri-apps/api/webviewWindow': { WebviewWindow: class { static async getByLabel() { return null } } },
  }).useSearchController({ editor: ref({ setSearch: (...args) => applied.push(args), runSearch: action => navigated.push(action), focus() {} }),
    documentLocked: ref(false), mainCloseInProgress: ref(false), appWindow: { setFocus: async () => {} }, showPersistenceNotice() {}, showError: async () => {} })
  t.after(c.dispose)
  c.setSidebarConditions({ search: '再会' }); assert.equal(applied.length, 0)
  c.onNavigate('next'); assert.equal(applied[0][0].search, '再会'); assert.deepEqual(navigated, ['next'])
  c.setSidebarConditions({ regexp: true, search: '^(a+)+$' }); assert.equal(applied.length, 1)
})

/** 読み取り専用の履歴Controllerに操作待ちを作り、遅着した本文も検証する。 */
function historyHarness(t, extra = {}) {
  const requests = [], path = ref('C:/作品/内側/原稿.txt'), active = ref(true), refreshRevision = ref(0)
  const entry = { id: 'a'.repeat(40), author: '作者', date: '2026-10-03', message: '初稿', path: '原稿.txt' }
  const c = loadSourceModule('src/useSidebarHistory.ts', {
    '@tauri-apps/api/core': { invoke: async (_command, { request }) => {
      requests.push(request)
      if (request.kind === 'list') return { version: 'git test', workspaces: [{ id: 1, root: 'C:/作品' }, { id: 2, root: 'C:/作品/内側' }] }
      if (request.kind === 'fileHistory') return { head: entry.id, branch: 'main', entries: [entry], hasMore: true }
      if (request.kind === 'blob') { if (extra.blob) return extra.blob(); return [255] }
      if (request.kind === 'export' && extra.exportError) throw extra.exportError
      return null
    } }, '@tauri-apps/plugin-dialog': { save: async () => extra.destination ?? null },
  }).useSidebarHistory({ path, active, refreshRevision, disabled: ref(false) })
  t.after(c.dispose)
  return { c, requests, path, active, refreshRevision, entry }
}

/** Vueの購読と直列Promiseの進行を待ち、実タイマーの長い待機を避ける。 */
async function settle() { for (let i = 0; i < 25; i++) await nextTick() }

/** 実際の設定ページの処理を実行し、WorkerとSFCのマクロだけを置き換える。 */
function rulePageHarness(t) {
  const vue = require('vue'), props = vue.reactive({ preferences: outline.createDefaultOutline() }), emitted = [], cleanup = []
  let fail = false
  const source = readFileSync(resolve(projectRoot, 'src/OutlineSettingsPage.vue'), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const scope = vue.effectScope()
  const page = scope.run(() => new Function('require', 'exports', 'defineProps', 'defineEmits', `${compiled}; return { draft, example, change, addRule, previewError }`)(specifier => {
    if (specifier === 'vue') return { ...vue, onBeforeUnmount: callback => cleanup.push(callback) }
    if (specifier === './outline') return outline
    if (specifier === './sidebarWorker') return { runSidebarAnalysis: async request => {
      if (fail) throw new Error('解析に時間がかかりすぎています。')
      return outline.extractOutline(request.text, request.preferences)
    } }
    throw new Error(specifier)
  }, {}, () => props, () => (_event, preferences) => { emitted.push(preferences); props.preferences = preferences }))
  t.after(() => { cleanup.forEach(callback => callback()); scope.stop() })
  return { page, props, emitted, fail: () => { fail = true } }
}

test('例文の更新で有効な設定変更の保存を失わず、同値再配信で未完成の入力を消さない', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = rulePageHarness(t)
  h.page.draft.value.rules[0].level = 4; h.page.change()
  h.page.example.value = '第一部 再会'; await nextTick()
  t.mock.timers.tick(200); await settle()
  assert.equal(h.emitted.length, 1); assert.equal(h.emitted[0].rules[0].level, 4)
  h.page.addRule(); assert.equal(h.page.draft.value.rules.length, 5)
  h.props.preferences = outline.cloneOutline(h.props.preferences); await nextTick()
  assert.equal(h.page.draft.value.rules.length, 5, '未完成の下書きを維持する')
  t.mock.timers.tick(200); await settle(); assert.equal(h.emitted.length, 1)
})

test('見出し判定の時間超過は設定へ送らず、理由をプレビューへ表示する', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = rulePageHarness(t); h.fail()
  h.page.draft.value.rules[0].level = 3; h.page.change()
  t.mock.timers.tick(200); await settle()
  assert.equal(h.emitted.length, 0); assert.match(h.page.previewError.value, /時間/)
})

test('簡易履歴は最も内側の管理を使い、UTF-8表示不可でも排他的な取り出しを実行できる', async t => {
  const h = historyHarness(t, { destination: 'D:/別の原稿.txt' }); await settle()
  assert.equal(h.c.workspace.value.id, 2); assert.match(h.c.previewError.value, /UTF-8/); assert.equal(h.c.canExport.value, true)
  await h.c.more(); assert.equal(h.requests.filter(r => r.kind === 'fileHistory').at(-1).head, h.entry.id)
  await h.c.exportFile(); assert.equal(h.requests.at(-1).kind, 'export'); assert.match(h.c.notice.value, /D:\/別の原稿/)
  assert.equal(h.requests.some(r => ['record', 'backup', 'restore', 'register'].includes(r.kind)), false)
})

test('履歴の本文取得失敗と削除記録は以前の本文を残さず、文書切替後の応答を捨てる', async t => {
  const waiting = deferred(), h = historyHarness(t, { blob: () => waiting.promise })
  await settle(); h.path.value = null; await nextTick(); waiting.release([65]); await settle()
  assert.equal(h.c.preview.value, ''); assert.equal(h.c.selected.value, null); assert.match(h.c.message.value, /無題/)
})

test('別の記録の取得失敗は以前の本文を消し、取り出しを無効にする', async t => {
  let fail = false
  const h = historyHarness(t, { blob: async () => { if (fail) throw new Error('取得失敗'); return [65] } }); await settle()
  assert.equal(h.c.preview.value, 'A')
  const next = { ...h.entry, id: 'b'.repeat(40) }; h.c.entries.value.push(next); fail = true
  await h.c.select(next)
  assert.equal(h.c.preview.value, ''); assert.match(h.c.previewError.value, /取得できません/); assert.equal(h.c.canExport.value, false)
})

test('本文の強調位置は編集時に消え、本文とUndo履歴へ変更を追加しない', () => {
  const { EditorState } = require('@codemirror/state'), { history, undoDepth } = require('@codemirror/commands')
  const { sidebarSearchHighlights, sidebarMatches } = loadSourceModule('src/sidebarSearchHighlights.ts')
  let state = EditorState.create({ doc: '再会', extensions: [history(), sidebarSearchHighlights] })
  state = state.update({ effects: sidebarMatches.of([{ from: 0, to: 2 }]) }).state
  assert.equal(state.doc.toString(), '再会'); assert.equal(undoDepth(state), 0); assert.equal(state.field(sidebarSearchHighlights).size, 1)
  state = state.update({ changes: { from: 0, insert: '第1章\n' } }).state
  assert.equal(state.field(sidebarSearchHighlights).size, 0); assert.equal(undoDepth(state), 1)
})

test('解析Workerの時間超過・中止・二重応答は必ずWorkerを破棄する', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const workers = [], previous = globalThis.Worker
  globalThis.Worker = class { constructor() { workers.push(this); this.ended = 0 } postMessage() {} terminate() { this.ended++ } }
  t.after(() => { if (previous) globalThis.Worker = previous; else delete globalThis.Worker })
  const compiled = ts.transpileModule(readFileSync(resolve(projectRoot, 'src/sidebarWorker.ts'), 'utf8').replace('import.meta.url', "'https://example.invalid/'"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }; new Function('exports', compiled)(module.exports)
  const timed = module.exports.runSidebarAnalysis({ kind: 'outline' }); const failure = assert.rejects(timed, /時間/)
  t.mock.timers.tick(2000); await failure; assert.equal(workers[0].ended, 1)
  workers[0].onmessage({ data: { result: [] } }); assert.equal(workers[0].ended, 1)
  const abort = new globalThis.AbortController(), cancelled = module.exports.runSidebarAnalysis({ kind: 'outline' }, abort.signal)
  const cancelledFailure = assert.rejects(cancelled, /中止/); abort.abort(); await cancelledFailure; assert.equal(workers[1].ended, 1)
})

test('境界ドラッグ開始時はパネル内のフォーカスを無効化前に切替ボタンへ戻す', t => {
  const vue = require('vue'), scope = vue.effectScope(), previousDocument = globalThis.document
  const props = vue.reactive({ activePanel: 'project', collapsed: false, disabled: false, resizing: false })
  const inside = {}, outside = {}, button = { classList: { contains: () => false }, focus: () => { globalThis.document.activeElement = button } }
  globalThis.document = { activeElement: inside }
  t.after(() => { scope.stop(); if (previousDocument) globalThis.document = previousDocument; else delete globalThis.document })
  const source = readFileSync(resolve(projectRoot, 'src/SidebarShell.vue'), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const shell = scope.run(() => new Function('require', 'exports', 'defineProps', 'defineEmits', `${compiled}; return { rail, content }`)(specifier => {
    if (specifier === 'vue') return vue
    if (specifier === './sidebarModel') return loadSourceModule('src/sidebarModel.ts')
    throw new Error(specifier)
  }, {}, () => props, () => () => {}))
  shell.rail.value = { querySelector: () => button }; shell.content.value = { contains: element => element === inside }
  props.resizing = true
  assert.equal(globalThis.document.activeElement, button)
  props.collapsed = true; props.resizing = false
  assert.equal(globalThis.document.activeElement, button)
  globalThis.document.activeElement = outside; props.resizing = true
  assert.equal(globalThis.document.activeElement, outside, '本文にあるフォーカスは移動しない')
})
