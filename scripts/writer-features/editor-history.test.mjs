/** メニュー用の履歴操作を、本物のCodeMirror状態と既存の検索処理で検証する。 */
import { assert, loadSourceModule, projectRoot, readFileSync, require, resolve, test, ts } from './test-support.mjs'

/** DOMだけを省略し、履歴・読み取り専用状態・フォーカス復帰を観測する。 */
function createHistoryView(text = '原稿') {
  const { Compartment, EditorState, Transaction } = require('@codemirror/state')
  const { history } = require('@codemirror/commands')
  const { createSearchExtensions } = loadSourceModule('src/searchPanel.ts')
  const lock = new Compartment()
  const view = {
    state: EditorState.create({ doc: text, extensions: [history(), createSearchExtensions(), lock.of(EditorState.readOnly.of(false))] }),
    composing: false,
    focusCount: 0,
    focus() { view.focusCount++ },
    plugin: () => null,
    dispatch(transaction) { view.state = transaction instanceof Transaction ? transaction.state : view.state.update(transaction).state },
    setReadOnly(value) { view.dispatch({ effects: lock.reconfigure(EditorState.readOnly.of(value)) }) },
  }
  return view
}

test('履歴操作は入力・取消・やり直し・再編集に追従し、成功時だけ本文へ戻る', () => {
  const { getEditorHistoryState, runEditorHistoryAction } = loadSourceModule('src/editorHistory.ts')
  const view = createHistoryView()
  assert.deepEqual(getEditorHistoryState(view.state), { canUndo: false, canRedo: false })
  assert.equal(runEditorHistoryAction(view, 'undo'), false)
  assert.equal(view.focusCount, 0)
  view.dispatch({ changes: { from: 2, insert: 'の続き' } })
  assert.deepEqual(getEditorHistoryState(view.state), { canUndo: true, canRedo: false })
  assert.equal(runEditorHistoryAction(view, 'undo'), true)
  assert.equal(view.state.doc.toString(), '原稿')
  assert.deepEqual(getEditorHistoryState(view.state), { canUndo: false, canRedo: true })
  assert.equal(runEditorHistoryAction(view, 'redo'), true)
  assert.equal(view.state.doc.toString(), '原稿の続き')
  assert.equal(view.focusCount, 2)
  runEditorHistoryAction(view, 'undo')
  view.dispatch({ changes: { from: 2, insert: 'を改稿' } })
  assert.deepEqual(getEditorHistoryState(view.state), { canUndo: true, canRedo: false })
  assert.equal(runEditorHistoryAction(view, 'redo'), false)
  view.state = createHistoryView('別文書').state
  assert.deepEqual(getEditorHistoryState(view.state), { canUndo: false, canRedo: false })
})

test('ロックとIME変換中はUndo/Redoを拒否し、履歴とフォーカスを保持する', () => {
  const { getEditorHistoryState, runEditorHistoryAction } = loadSourceModule('src/editorHistory.ts')
  for (const action of ['undo', 'redo']) {
    const view = createHistoryView()
    view.dispatch({ changes: { from: 2, insert: '追記' } })
    if (action === 'redo') runEditorHistoryAction(view, 'undo')
    for (const blockedBy of ['readOnly', 'composing']) {
      if (blockedBy === 'readOnly') view.setReadOnly(true)
      else view.composing = true
      const before = view.state, focusCount = view.focusCount
      assert.equal(runEditorHistoryAction(view, action), false)
      assert.equal(view.state, before)
      assert.equal(view.focusCount, focusCount)
      if (blockedBy === 'readOnly') {
        assert.deepEqual(getEditorHistoryState(view.state), { canUndo: false, canRedo: false })
        view.setReadOnly(false)
      } else view.composing = false
    }
    assert.equal(runEditorHistoryAction(view, action), true)
  }
})

test('メニュー用Undo/Redoは一件置換・全置換と本文の履歴を共有する', () => {
  const { getEditorHistoryState, runEditorHistoryAction } = loadSourceModule('src/editorHistory.ts')
  const { updateEditorSearch, runEditorSearchAction } = loadSourceModule('src/searchPanel.ts')
  for (const action of ['replace', 'replaceAll']) {
    const view = createHistoryView('星 星')
    updateEditorSearch(view, { search: '星', replace: '月', caseSensitive: false, regexp: false }, true)
    runEditorSearchAction(view, 'next')
    runEditorSearchAction(view, action)
    const replaced = view.state.doc.toString()
    assert.equal(replaced, action === 'replaceAll' ? '月 月' : '月 星')
    assert.equal(getEditorHistoryState(view.state).canUndo, true)
    assert.equal(runEditorHistoryAction(view, 'undo'), true)
    assert.equal(view.state.doc.toString(), '星 星')
    assert.equal(runEditorHistoryAction(view, 'redo'), true)
    assert.equal(view.state.doc.toString(), replaced)
  }
})

test('履歴ボタンは既定構成と初期化に加わり、保存済み配置は書き換えない', () => {
  const schema = loadSourceModule('src/appPreferenceSchema.ts')
  const commands = loadSourceModule('src/appCommands.ts')
  const defaults = schema.createDefaultApplicationPreferences()
  assert.deepEqual(defaults.ui.toolbar.items.slice(0, 2), [
    { type: 'command', commandId: 'edit.undo' }, { type: 'command', commandId: 'edit.redo' },
  ])
  assert.equal(defaults.ui.toolbar.items[2].type, 'separator')
  const previous = [{ type: 'command', commandId: 'wrap.window' }, { type: 'separator', id: 'custom' }]
  assert.deepEqual(schema.normalizeToolbarItems(previous), previous)
  assert.deepEqual(schema.normalizeToolbarItems([]), [])
  const customized = { ...defaults, ui: { ...defaults.ui, toolbar: { visible: false, items: [...previous, defaults.ui.toolbar.items[1], defaults.ui.toolbar.items[0]] } } }
  assert.deepEqual(schema.normalizeApplicationPreferences(JSON.parse(JSON.stringify(customized))), customized)
  assert.deepEqual(schema.resetToolbarPreferences(customized.ui.toolbar), { visible: false, items: defaults.ui.toolbar.items })
  for (const id of ['edit.undo', 'edit.redo']) assert.ok(commands.getToolbarCommandDefinitions().some(command => command.id === id))
})

/** Appの関数をそのまま実行し、実行可否とショートカットの分岐を検査する。 */
function loadAppFunctions() {
  const source = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const functions = ['isCommandDisabled', 'onKeydown'].map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n')
  const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const state = Object.fromEntries(['mainCloseInProgress', 'gitHistoryOpen', 'documentLocked', 'editorInteractionLocked', 'busy'].map(name => [name, { value: false }]))
  Object.assign(state, {
    documentSession: { externalDialog: { value: null } }, recentFiles: { isOpen: { value: false } }, quickOpen: { isOpen: { value: false } },
    editor: { value: {} }, editorHistoryState: { value: { canUndo: true, canRedo: true } },
  })
  const executed = []
  const { findShortcutCommand } = loadSourceModule('src/appCommands.ts')
  return { state, executed, ...new Function(...Object.keys(state), 'findShortcutCommand', 'executeCommand', `${compiled}\nreturn { isCommandDisabled, onKeydown }`)(...Object.values(state), findShortcutCommand, id => executed.push(id)) }
}

test('メニューとツールバーは履歴・ロック・モーダルの最新状態で無効になる', () => {
  const { state, isCommandDisabled } = loadAppFunctions()
  for (const id of ['edit.undo', 'edit.redo']) {
    assert.equal(isCommandDisabled(id), false)
    for (const blocked of [state.mainCloseInProgress, state.gitHistoryOpen, state.documentSession.externalDialog, state.recentFiles.isOpen, state.quickOpen.isOpen, state.editorInteractionLocked]) {
      blocked.value = true
      assert.equal(isCommandDisabled(id), true)
      blocked.value = false
    }
    state.editorHistoryState.value[id === 'edit.undo' ? 'canUndo' : 'canRedo'] = false
    assert.equal(isCommandDisabled(id), true)
  }
})

test('Ctrl+Z/Yは入力先に委ね、既存ショートカットは実行する', () => {
  const { executed, onKeydown } = loadAppFunctions()
  let prevented = 0
  const base = { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, preventDefault: () => { prevented++ } }
  for (const key of ['z', 'y', 'Z', 'Y']) onKeydown({ ...base, key })
  onKeydown({ ...base, key: 'z', shiftKey: true })
  onKeydown({ ...base, key: 'z', isComposing: true })
  assert.equal(prevented, 0)
  assert.deepEqual(executed, [])
  onKeydown({ ...base, key: 's' })
  assert.equal(prevented, 1)
  assert.deepEqual(executed, ['document.save'])
})

test('EditorPaneは初期表示・履歴操作・読取専用・行移動・文書切替の状態を通知する', async () => {
  const vue = require('vue')
  const { EditorView } = require('@codemirror/view')
  const { Transaction } = require('@codemirror/state')
  const source = readFileSync(resolve(projectRoot, 'src/EditorPane.vue'), 'utf8')
  const script = source.match(/<script setup lang="ts">([^]*?)<\/script>/)[1].replaceAll('import.meta.url', "'file:///test/EditorPane.vue'")
  const compiled = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const props = vue.reactive({ settings: loadSourceModule('src/editorSettings.ts').defaultEditorSettings, readOnly: false })
  const events = [], scope = vue.effectScope()
  let mounted
  const pane = scope.run(() => new Function('require', 'defineProps', 'defineEmits', 'defineExpose', 'exports', `${compiled}\nreturn { createState, setDocument, runHistory, reportHistoryState, lineNavigationOpen, attachView: candidate => { view = candidate } }`)(
    id => id === 'vue' ? { ...vue, onMounted: callback => { mounted = callback }, onBeforeUnmount() {} }
      : id.endsWith('.vue') ? {} : id.startsWith('.') ? loadSourceModule(`src/${id.slice(2)}.ts`) : require(id),
    () => props, () => (...event) => events.push(event), () => {}, {},
  ))
  const view = {
    state: pane.createState('原稿'), composing: false, focus() {},
    setState(state) { view.state = state },
    dispatch(spec) {
      const startState = view.state
      const transaction = spec instanceof Transaction ? spec : startState.update(spec)
      view.state = transaction.state
      const update = { startState, state: view.state, docChanged: transaction.docChanged, selectionSet: !!transaction.selection, transactions: [transaction] }
      for (const listener of view.state.facet(EditorView.updateListener)) listener(update)
    },
  }
  const latest = () => events.filter(([name]) => name === 'historyState').at(-1)?.[1]
  try {
    assert.equal(typeof mounted, 'function')
    pane.attachView(view)
    pane.reportHistoryState()
    assert.deepEqual(latest(), { canUndo: false, canRedo: false })
    view.dispatch({ changes: { from: 2, insert: '追記' } })
    assert.deepEqual(latest(), { canUndo: true, canRedo: false })
    assert.equal(pane.runHistory('undo'), true)
    assert.deepEqual(latest(), { canUndo: false, canRedo: true })
    assert.equal(events.filter(([name]) => name === 'change').at(-1)[1], '原稿')
    props.readOnly = true
    assert.deepEqual(latest(), { canUndo: false, canRedo: false })
    assert.equal(pane.runHistory('redo'), false)
    props.readOnly = false
    assert.deepEqual(latest(), { canUndo: false, canRedo: true })
    pane.lineNavigationOpen.value = true
    assert.deepEqual(latest(), { canUndo: false, canRedo: false })
    assert.equal(pane.runHistory('redo'), false)
    pane.lineNavigationOpen.value = false
    assert.equal(pane.runHistory('redo'), true)
    pane.setDocument('別文書')
    assert.deepEqual(latest(), { canUndo: false, canRedo: false })
    assert.equal(pane.runHistory('undo'), false)
    assert.equal(view.state.doc.toString(), '別文書')
  } finally { scope.stop() }
})
