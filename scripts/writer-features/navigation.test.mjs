/** 長文の行移動と、本文・編集履歴の保全を検証する。 */
import { assert, loadSourceModule, projectRoot, readFileSync, require, resolve, test, ts } from './test-support.mjs'

test('行番号は論理行の範囲内の整数だけを受け付ける', () => {
  const { parseLineNumber } = loadSourceModule('src/editorNavigation.ts')
  for (const [input, expected] of [['1', 1], [' 12 ', 12], ['003', 3], ['20', 20]]) {
    assert.equal(parseLineNumber(input, 20), expected)
  }
  for (const input of ['', ' ', '0', '-1', '21', '1.5', '1e1', '+2', 'Infinity', '２', '9007199254740992']) {
    assert.equal(parseLineNumber(input, 20), null, input)
  }
  assert.equal(parseLineNumber('1', 1), 1)
})

test('行移動は折り返しやUTF-16長によらず行頭を選び、本文のUndo/Redoを維持する', () => {
  const { EditorState, Transaction } = require('@codemirror/state')
  const { history, undo, redo } = require('@codemirror/commands')
  const { goToEditorLine } = loadSourceModule('src/editorNavigation.ts')
  const text = '序章😀\n長い段落'.repeat(50) + '\n\n結び\n'
  const view = {
    state: EditorState.create({ doc: text, extensions: [history()] }),
    dispatch(transaction) {
      view.state = transaction instanceof Transaction ? transaction.state : view.state.update(transaction).state
    },
  }
  view.dispatch({ changes: { from: 0, insert: '改稿' } })
  const edited = view.state.doc.toString()
  for (const line of [1, 2, view.state.doc.lines - 1, view.state.doc.lines]) {
    assert.equal(goToEditorLine(view, line), true)
    assert.equal(view.state.selection.main.head, view.state.doc.line(line).from)
    assert.equal(view.state.selection.main.empty, true)
    assert.equal(view.state.doc.toString(), edited)
  }
  assert.equal(undo(view), true)
  assert.equal(view.state.doc.toString(), text)
  assert.equal(redo(view), true)
  assert.equal(view.state.doc.toString(), edited)
  const before = view.state
  for (const line of [0, -1, 1.5, NaN, Infinity, view.state.doc.lines + 1]) {
    assert.equal(goToEditorLine(view, line), false)
    assert.equal(view.state, before)
  }
  view.state = EditorState.create({ doc: '一\n二', extensions: [EditorState.readOnly.of(true)] })
  assert.equal(goToEditorLine(view, 2), false)
  assert.equal(view.state.selection.main.head, 0)
})

test('行移動コマンドはツールバーに登録でき、Ctrl+GとIMEを区別する', () => {
  const { findShortcutCommand, getToolbarCommandDefinitions } = loadSourceModule('src/appCommands.ts')
  const event = { key: 'g', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isComposing: false }
  assert.equal(findShortcutCommand(event)?.id, 'edit.goToLine')
  assert.equal(findShortcutCommand({ ...event, isComposing: true }), undefined)
  assert.equal(findShortcutCommand({ ...event, shiftKey: true }), undefined)
  assert.equal(getToolbarCommandDefinitions().some(({ id }) => id === 'edit.goToLine'), true)
})

test('行移動ダイアログは現在行を初期表示し、不正値・ロック・IME確定で移動しない', async () => {
  const vue = require('vue')
  const source = readFileSync(resolve(projectRoot, 'src/GoToLineDialog.vue'), 'utf8')
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const compiled = ts.transpileModule(script, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const props = vue.reactive({ modelValue: false, currentLine: 7, lineCount: 10, disabled: false })
  const events = []
  const scope = vue.effectScope()
  const dialog = scope.run(() => new Function('require', 'defineProps', 'defineEmits', 'exports',
    `${compiled}\nreturn { value, onKeydown }`)(
    (id) => id === 'vue' ? vue : loadSourceModule('src/editorNavigation.ts'),
    () => props, () => (...event) => events.push(event), {},
  ))
  try {
    props.modelValue = true
    await vue.nextTick()
    assert.equal(dialog.value.value, '7')
    let prevented = 0
    const event = { key: 'Enter', isComposing: false, keyCode: 13, preventDefault: () => { prevented += 1 } }
    dialog.onKeydown({ ...event, isComposing: true })
    dialog.onKeydown({ ...event, keyCode: 229 })
    assert.equal(prevented, 0)
    assert.deepEqual(events, [])
    dialog.value.value = '11'
    dialog.onKeydown(event)
    dialog.value.value = '5'
    props.disabled = true
    dialog.onKeydown(event)
    assert.deepEqual(events, [])
    props.disabled = false
    dialog.onKeydown(event)
    assert.deepEqual(events, [['navigate', 5], ['update:modelValue', false]])
  } finally {
    scope.stop()
  }
})
