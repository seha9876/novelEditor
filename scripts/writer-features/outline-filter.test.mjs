/** アウトラインの絞り込みと、折りたたみ・キーボード移動・本文世代の連携を検証する。 */
import { assert, deferred, loadSourceModule, projectRoot, readFileSync, require, resolve, test, ts } from './test-support.mjs'

const vue = require('vue')
const outline = loadSourceModule('src/outline.ts')
const manuscript = '第一部 出会い\n第一章 ＳＴＡＲ\n第一節 朝\n第二節 再会\n第二章 出発\n第二部 帰還\n第三章 Star\n第一節 再会\n終章 結び'

test('見出しの絞り込みは全半角・大小文字を揃え、一致と親の階層を区別する', () => {
  const headings = outline.extractOutline(manuscript, outline.createDefaultOutline())
  const before = JSON.stringify(headings)
  const found = outline.filterOutlineHeadings(headings, ' star ')
  assert.equal(found.active, true)
  assert.deepEqual([...found.matched], [1, 6])
  assert.deepEqual([...found.included].sort((a, b) => a - b), [0, 1, 5, 6])
  const nested = outline.filterOutlineHeadings(headings, '再会')
  assert.deepEqual([...nested.matched], [3, 7])
  assert.deepEqual([...nested.included].sort((a, b) => a - b), [0, 1, 3, 5, 6, 7])
  assert.equal(outline.filterOutlineHeadings(headings, '第一部').included.size, 1, '親の一致で無関係な子を表示しない')
  assert.equal(JSON.stringify(headings), before)
})

test('空白だけの条件は解除とし、記号は正規表現にせず、同名の見出しも省略しない', () => {
  const headings = outline.extractOutline('第一章 [再会]\n第二章 [再会]\n第二章 [再会]', outline.createDefaultOutline())
  for (const query of ['', '　 \t ']) assert.equal(outline.filterOutlineHeadings(headings, query).active, false)
  assert.equal(outline.filterOutlineHeadings(headings, '[').matched.size, 3)
  assert.equal(outline.filterOutlineHeadings(headings, '.*').matched.size, 0)
  assert.equal(outline.filterOutlineHeadings([], '再会').matched.size, 0)
})

/** Vueの購読とWorker応答を進め、実時間の待機に依存させない。 */
async function settle() { for (let i = 0; i < 15; i++) await vue.nextTick() }

/** 実際のパネルを実行し、WorkerとDOMのフォーカス境界だけを置き換える。 */
function panelHarness(t, analyze = async request => outline.extractOutline(request.text, request.preferences)) {
  const document = { text: manuscript, revision: 1 }, requests = [], navigations = [], cleanup = [], focusedRows = []
  const dom = { activeElement: null }
  const props = vue.reactive({ active: true, revision: 1, head: 0, documentKey: 'test.txt', disabled: false,
    preferences: outline.createDefaultOutline(), editor: { getDocumentSnapshot: () => ({ ...document }), revealRange: target => { navigations.push(target); return target.revision === document.revision } } })
  const source = readFileSync(resolve(projectRoot, 'src/OutlinePanel.vue'), 'utf8').match(/<script setup lang="ts">([^]*?)<\/script>/)[1]
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const scope = vue.effectScope()
  const panel = scope.run(() => new Function('require', 'exports', 'defineProps', 'defineEmits', 'document', `${compiled}; return { query, filter, visible, parents, collapsed, keys, focused, headings, list, pending, stale, toggle, navigate, onKey, onFilterKey }`)(specifier => {
    if (specifier === 'vue') return { ...vue, onBeforeUnmount: callback => cleanup.push(callback) }
    if (specifier === './outline') return outline
    if (specifier === './sidebarWorker') return { runSidebarAnalysis: (request, signal) => { requests.push({ request, signal }); return analyze(request, signal) } }
    throw new Error(specifier)
  }, {}, () => props, () => () => {}, dom))
  panel.list.value = {
    contains: element => element !== null,
    querySelector: selector => {
      const index = Number(selector.match(/"(\d+)"/)[1])
      return panel.visible.value.some(heading => heading.index === index) ? { focus: () => { focusedRows.push(index); dom.activeElement = index } } : null
    },
  }
  t.after(() => { cleanup.forEach(callback => callback()); scope.stop() })
  return { props, panel, document, requests, navigations, focusedRows, dom }
}

/** 防止された既定動作も観測できる、修飾キーなしの入力を作る。 */
function keyEvent(key, extra = {}) {
  return { key, prevented: false, stopped: false, isComposing: false, keyCode: 0,
    preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, ...extra }
}

test('折りたたんだ階層の一致を表示し、解除後に元の開閉を復元する。条件入力では本文を再解析しない', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = panelHarness(t)
  t.mock.timers.tick(200); await settle()
  h.panel.toggle(0); await settle()
  const collapsed = [...h.panel.collapsed.value]
  assert.deepEqual(h.panel.visible.value.map(heading => heading.index), [0, 5, 6, 7, 8])
  h.panel.query.value = '再会'; await settle()
  assert.deepEqual(h.panel.visible.value.map(heading => heading.index), [0, 1, 3, 5, 6, 7])
  h.panel.toggle(0)
  assert.deepEqual(h.panel.collapsed.value, collapsed)
  assert.equal(h.panel.filter.value.matched.size, 2)
  h.panel.query.value = '見つからない'; await settle()
  assert.deepEqual(h.panel.visible.value, [])
  h.panel.query.value = ''; await settle()
  assert.deepEqual(h.panel.visible.value.map(heading => heading.index), [0, 5, 6, 7, 8])
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.navigations, [])
  assert.equal(h.document.text, manuscript)
})

test('絞り込み中は表示した親子だけへキー移動し、入力欄のEnterで最初の一致へ進む', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = panelHarness(t)
  t.mock.timers.tick(200); await settle()
  h.panel.query.value = '再会'; await settle()
  h.panel.onFilterKey(keyEvent('ArrowDown')); await settle()
  assert.deepEqual(h.focusedRows, [3])
  assert.deepEqual(h.navigations, [])
  await h.panel.onKey(keyEvent('ArrowLeft'), 3)
  assert.equal(h.panel.focused.value, 1)
  await h.panel.onKey(keyEvent('ArrowRight'), 1)
  assert.equal(h.panel.focused.value, 3, '非表示の第一節へは進まない')
  await h.panel.onKey(keyEvent('ArrowDown'), 3)
  assert.equal(h.panel.focused.value, 5)
  const enter = keyEvent('Enter')
  h.panel.onFilterKey(enter)
  assert.equal(enter.prevented, true)
  assert.deepEqual(h.navigations, [{ revision: 1, from: h.panel.headings.value[3].from, to: h.panel.headings.value[3].from }])
  h.panel.navigate(2)
  assert.equal(h.navigations.length, 1, '非表示の行へは移動しない')
  const escape = keyEvent('Escape')
  h.panel.onFilterKey(escape); await settle()
  assert.equal(h.panel.query.value, '')
  assert.equal(escape.prevented, true); assert.equal(escape.stopped, true)
})

test('IME・修飾キー・ロック・古い解析中は本文へ移動しない', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = panelHarness(t)
  t.mock.timers.tick(200); await settle()
  h.panel.query.value = '再会'; await settle()
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
    const enter = keyEvent('Enter', extra), escape = keyEvent('Escape', extra)
    h.panel.onFilterKey(enter); h.panel.onFilterKey(escape)
    await h.panel.onKey(enter, 3)
    assert.equal(enter.prevented, false); assert.equal(escape.prevented, false)
    assert.equal(h.panel.query.value, '再会')
  }
  h.props.disabled = true; h.panel.onFilterKey(keyEvent('Enter'))
  h.props.disabled = false; h.document.revision++; h.props.revision++; await settle()
  assert.equal(h.panel.stale.value, true)
  h.panel.onFilterKey(keyEvent('Enter')); h.panel.navigate(3)
  assert.deepEqual(h.navigations, [])
  t.mock.timers.tick(200); await settle()
  h.panel.onFilterKey(keyEvent('Enter'))
  assert.equal(h.navigations[0].revision, 2)
})

test('表示対象からフォーカス行が消えたら表示中の親へ戻り、入力中はフォーカスを奪わない', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = panelHarness(t)
  t.mock.timers.tick(200); await settle()
  h.panel.focused.value = 3; h.dom.activeElement = 3
  h.panel.toggle(0); await settle()
  assert.equal(h.panel.focused.value, 0)
  assert.equal(h.focusedRows.at(-1), 0)
  h.dom.activeElement = null
  h.panel.query.value = 'Star'; await settle()
  const count = h.focusedRows.length
  h.panel.query.value = '結び'; await settle()
  assert.equal(h.panel.focused.value, 5)
  assert.equal(h.focusedRows.length, count)
})

test('文書切替後の遅着した解析を破棄し、絞り込みを新しい見出しへ適用する', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const old = deferred()
  const h = panelHarness(t, request => request.text === manuscript ? old.promise : outline.extractOutline(request.text, request.preferences))
  h.panel.query.value = '再会'
  t.mock.timers.tick(200); await settle()
  h.document.text = '第一章 再会\n本文'; h.document.revision = 2
  h.props.revision = 2; h.props.documentKey = 'next.txt'; await settle()
  assert.equal(h.requests[0].signal.aborted, true)
  t.mock.timers.tick(200); await settle()
  old.release(outline.extractOutline(manuscript, outline.createDefaultOutline())); await settle()
  assert.equal(h.panel.query.value, '再会')
  assert.deepEqual(h.panel.visible.value.map(heading => heading.text), ['第一章 再会'])
  assert.equal(h.panel.filter.value.matched.size, 1)
  assert.equal(h.panel.stale.value, false)
  assert.deepEqual(h.navigations, [])
})
