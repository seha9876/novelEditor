/** 検索履歴の通信順序・削除競合と、実際の検索セッションへの接続を検証する。 */
import { URL } from 'node:url'
import { assert, deferred, loadSourceModule, projectRoot, readFileSync, require, resolve, test, ts } from './test-support.mjs'

const conditions = { search: '星\n月', replace: '$1\n', caseSensitive: true, regexp: false }

/** 履歴一覧の実関数を読み、DOMフォーカスと親への通知だけを記録する。 */
function menuHarness() {
  const source = readFileSync(resolve(projectRoot, 'src/SearchHistoryMenu.vue'), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const parsed = ts.createSourceFile('menu.ts', source, ts.ScriptTarget.Latest, true)
  const code = ts.transpileModule(parsed.statements.filter(n => ts.isVariableStatement(n) || ts.isFunctionDeclaration(n)).map(n => n.getText(parsed)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const { ref, nextTick } = require('vue'), events = [], dom = { activeElement: null }
  const props = { disabled: false, state: { busy: false } }
  const menu = new Function('ref', 'nextTick', 'defineProps', 'defineEmits', 'document', `${code}; return { open, confirmClear, content, select, clear, onKey, onActivatorKey }`)(
    ref, nextTick, () => props, () => (...args) => events.push(args), dom,
  )
  return { menu, props, events, dom }
}

test('一覧と開いた直後のボタンでEscapeを閉じ込め、矢印キーで有効な項目へ移る', () => {
  const { menu, dom } = menuHarness(), focused = []
  menu.content.value = { querySelectorAll: () => [0, 1, 2].map(n => ({ focus: () => focused.push(n) })) }
  menu.open.value = true
  const down = { key: 'ArrowDown', preventDefault() {}, stopPropagation() {} }
  menu.onActivatorKey(down); menu.onActivatorKey({ ...down, key: 'ArrowUp' })
  assert.deepEqual(focused, [0, 2]); assert.equal(dom.activeElement, null)
  let stopped = 0
  const escape = { key: 'Escape', preventDefault() {}, stopPropagation: () => stopped++ }
  menu.confirmClear.value = true; menu.onKey(escape)
  assert.equal(menu.confirmClear.value, false); assert.equal(menu.open.value, true)
  menu.onActivatorKey(escape)
  assert.equal(menu.open.value, false); assert.equal(stopped, 2)
  menu.onActivatorKey(escape); assert.equal(stopped, 2, '閉じていれば検索窓の通常キー処理へ委ねる')
})

test('履歴選択は条件だけを通知し、無効状態では選択と全件削除を受け付けない', async () => {
  const { menu, props, events } = menuHarness()
  menu.open.value = true
  await menu.select({ id: 1, conditions })
  assert.equal(menu.open.value, false)
  assert.deepEqual(events, [['select', conditions]])
  props.disabled = true; await menu.select({ id: 1, conditions }); menu.clear()
  assert.equal(events.length, 1)
  props.disabled = false; menu.clear()
  assert.deepEqual(events[1], ['mutate', { type: 'clear' }])
})

test('履歴の読込と保存を直列化し、条件を呼出時に固定する', async () => {
  const gate = deferred(), calls = []
  const { useSearchHistory } = loadSourceModule('src/searchHistory.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      calls.push([command, args]); if (command === 'search_history_list') await gate.promise
      return command === 'search_history_record' ? [{ id: 1, conditions: args.conditions }] : []
    } },
  })
  const history = useSearchHistory(() => {})
  const loading = history.load(), input = { ...conditions }
  history.record(input); input.search = '別条件'
  await Promise.resolve()
  assert.deepEqual(calls.map(call => call[0]), ['search_history_list'])
  assert.equal(history.state.value.busy, true)
  gate.release(); await loading; await history.flush()
  assert.equal(history.state.value.busy, false)
  assert.deepEqual(history.state.value.entries, [{ id: 1, conditions }])
  await history.dispose()
})

test('削除前の保存は先に完了させ、遅い検索の登録は削除後に復活させない', async () => {
  for (const action of [{ type: 'clear' }, { type: 'remove', id: 1 }]) {
    const gate = deferred(), calls = []
    const { useSearchHistory } = loadSourceModule('src/searchHistory.ts', {
      '@tauri-apps/api/core': { invoke: async command => {
        calls.push(command)
        if (command === 'search_history_record') await gate.promise
        return []
      } },
    })
    const history = useSearchHistory(() => {})
    const lateRecord = history.prepareRecord(conditions)
    history.record(conditions)
    const deleting = history.mutate(action)
    lateRecord()
    await Promise.resolve()
    assert.deepEqual(calls, ['search_history_record'])
    gate.release(); await deleting
    assert.deepEqual(calls, ['search_history_record', `search_history_${action.type}`])
    history.record(conditions); await history.flush()
    assert.equal(calls.length, 3, '削除後の新しい明示操作は記録できる')
    await history.dispose()
  }
})

test('保存失敗で既存一覧を失わず、再試行と終了待機ができる', async () => {
  let fail = false
  const calls = [], entries = [{ id: 1, conditions }]
  const { useSearchHistory } = loadSourceModule('src/searchHistory.ts', {
    '@tauri-apps/api/core': { invoke: async command => { calls.push(command); if (fail) throw new Error('DB error'); return entries } },
  })
  const history = useSearchHistory(() => {})
  await history.load(); fail = true
  await history.mutate({ type: 'clear' })
  assert.deepEqual(history.state.value.entries, entries)
  assert.match(history.state.value.error, /DB error/)
  fail = false; history.record({ ...conditions, search: ' ' }); await history.flush()
  assert.equal(history.state.value.error, '')
  history.record({ ...conditions, search: '' })
  assert.equal(calls.length, 3)
  await history.dispose(); history.record(conditions); await history.load()
  assert.equal(calls.length, 3)
})

test('空白・改行・タブを表示上だけ識別し、保存文字列を加工しない', () => {
  const { previewSearchHistory } = loadSourceModule('src/searchHistory.ts')
  assert.equal(previewSearchHistory(' \t\r\n星'), '␠⇥␍↵星')
  assert.equal(previewSearchHistory(''), '（空文字）')
  assert.equal(conditions.search, '星\n月')
})

/** CodeMirrorを実際に動かし、履歴には操作前の条件を保存するコントローラーを作る。 */
async function controllerHarness() {
  const { ref } = require('vue'), { EditorState, Transaction } = require('@codemirror/state')
  const panel = loadSourceModule('src/searchPanel.ts')
  const view = {
    state: EditorState.create({ doc: '星\n月', extensions: [panel.createSearchExtensions()] }),
    composing: false, plugin: () => null,
    dispatch: transaction => { view.state = transaction instanceof Transaction ? transaction.state : view.state.update(transaction).state },
  }
  let listener, sessionId, sequence = 0
  const snapshots = [], calls = [], locked = ref(false)
  class SearchWindow {
    constructor(_label, options) { sessionId = new URL(options.url, 'http://localhost').searchParams.get('session') }
    async once() {}
    async destroy() {}
  }
  const { useSearchController } = loadSourceModule('src/useSearchController.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => { calls.push([command, args]); return command === 'search_history_record' ? [{ id: 1, conditions: args.conditions }] : [] } },
    '@tauri-apps/api/event': { listen: async (_event, callback) => { listener = callback; return () => {} }, emitTo: async (_label, _event, snapshot) => { snapshots.push(snapshot) } },
    '@tauri-apps/api/webviewWindow': { WebviewWindow: SearchWindow },
  })
  const controller = useSearchController({
    editor: ref({ setSearch: input => { panel.updateEditorSearch(view, input, false) }, runSearch: action => panel.runEditorSearchAction(view, action),
      getSearchScope: () => panel.getEditorSearchScope(view), focus() {} }),
    documentLocked: locked, mainCloseInProgress: ref(false), appWindow: { async setFocus() {} }, showPersistenceNotice() {}, async showError() {},
  })
  await controller.setup(); await controller.open('search'); listener({ payload: { type: 'ready', sessionId } })
  return { controller, view, calls, snapshots, locked,
    send: patch => listener({ payload: { type: 'action', sessionId, sequence: ++sequence, documentRevision: snapshots.at(-1).documentRevision, conditions: { ...conditions }, action: 'next', ...patch } }),
  }
}

test('検索・置換・F3の受理時だけ保存し、条件変更と履歴選択では本文や履歴を変更しない', async () => {
  const h = await controllerHarness()
  h.send({ type: 'change' }); await h.controller.flushHistory()
  assert.equal(h.calls.length, 1)
  h.send({ action: 'replaceAll', conditions: { ...conditions, search: '星', replace: '日' } })
  await h.controller.flushHistory()
  assert.equal(h.view.state.doc.toString(), '日\n月')
  assert.equal(h.calls.at(-1)[1].conditions.search, '星')
  assert.equal(h.snapshots.at(-1).history.entries[0].conditions.replace, '日')
  const savedCount = h.calls.length
  h.controller.setSidebarConditions(conditions)
  await h.controller.flushHistory()
  assert.equal(h.calls.length, savedCount)
  assert.equal(h.view.state.doc.toString(), '日\n月')
  h.controller.onNavigate('next'); await h.controller.flushHistory()
  assert.equal(h.calls.length, savedCount + 1, '一致なしの有効な検索も記録する')
  await h.controller.close()
  h.controller.setSidebarConditions({ replace: '新しい置換語' })
  h.controller.onNavigate('next'); await h.controller.flushHistory()
  assert.equal(h.calls.at(-1)[1].conditions.replace, '新しい置換語', '検索語が同じでも置換語だけ違う条件をF3で記録する')
  await h.controller.dispose()
})

test('不正条件・IME・ロック・古い窓世代は記録せず、削除要求にも連番を適用する', async () => {
  const h = await controllerHarness()
  h.send({ conditions: { ...conditions, search: '[', regexp: true } })
  h.send({ conditions: { ...conditions, search: '' } })
  h.view.composing = true; h.send({}); h.view.composing = false
  const oldRevision = h.snapshots.at(-1).documentRevision
  h.locked.value = true; h.send({}); h.send({ type: 'history', historyAction: { type: 'clear' } })
  h.locked.value = false
  h.send({ documentRevision: oldRevision }); h.send({ sessionId: 'old' })
  await h.controller.flushHistory()
  assert.equal(h.calls.length, 1)
  h.send({ type: 'history', historyAction: { type: 'clear' } }); await h.controller.flushHistory()
  h.send({ type: 'history', sequence: 1, historyAction: { type: 'clear' } }); await h.controller.flushHistory()
  assert.deepEqual(h.calls.map(call => call[0]), ['search_history_list', 'search_history_clear'])
  assert.equal(h.view.state.doc.toString(), '星\n月')
  await h.controller.dispose()
})
