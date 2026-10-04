/** 空白の表示範囲、本文保全、既存の設定保存・履歴経路を検証する。 */
import { assert, loadSourceModule, require, test } from './test-support.mjs'

test('空白表示は旧設定でOFFとなり、boolean以外を受け付けない', () => {
  const { normalizeEditorSettings } = loadSourceModule('src/editorSettings.ts')
  for (const showWhitespace of [undefined, null, 'true', 'false', 1, 0, {}, []]) {
    assert.equal(normalizeEditorSettings({ showWhitespace }).showWhitespace, false)
  }
  assert.equal(normalizeEditorSettings({ showWhitespace: true }).showWhitespace, true)
  assert.equal(normalizeEditorSettings({ showWhitespace: false }).showWhitespace, false)
})

/** CodeMirrorの装飾集合を文字範囲・クラスの配列へ変換する。 */
function decorationRanges(decorations) {
  const result = []
  for (let cursor = decorations.iter(); cursor.value; cursor.next()) {
    result.push({ from: cursor.from, to: cursor.to, class: cursor.value.spec.class })
  }
  return result
}

test('空白装飾は半角・全角・タブを区別し、長文の表示範囲と編集に追従する', () => {
  const { EditorState } = require('@codemirror/state')
  const { createWhitespaceExtensions } = loadSourceModule('src/editorWhitespace.ts')
  const text = '前 \t　後\n' + '本文　\n'.repeat(50000)
  const view = {
    state: EditorState.create({ doc: text }),
    visibleRanges: [{ from: 0, to: 6 }],
    viewport: { from: 0, to: 6 },
  }
  const plugins = createWhitespaceExtensions(true).map((extension) => extension.create(view))
  assert.deepEqual(decorationRanges(plugins[0].decorations), [
    { from: 1, to: 2, class: 'cm-highlightSpace' },
    { from: 2, to: 3, class: 'cm-highlightTab' },
  ])
  assert.deepEqual(decorationRanges(plugins[1].decorations), [{ from: 3, to: 4, class: 'cm-highlightFullWidthSpace' }])
  const transaction = view.state.update({ changes: { from: 3, to: 4, insert: '　　' } })
  view.state = transaction.state
  for (const plugin of plugins) {
    plugin.update({ view, docChanged: true, changes: transaction.changes, viewportMoved: false })
  }
  assert.deepEqual(decorationRanges(plugins[1].decorations), [
    { from: 3, to: 4, class: 'cm-highlightFullWidthSpace' },
    { from: 4, to: 5, class: 'cm-highlightFullWidthSpace' },
  ])
  const lastLine = view.state.doc.line(view.state.doc.lines - 1)
  view.viewport = { from: lastLine.from, to: lastLine.to }
  view.visibleRanges = [view.viewport]
  for (const plugin of plugins) plugin.update({ view, docChanged: false, viewportMoved: true })
  assert.deepEqual(decorationRanges(plugins[1].decorations), [
    { from: lastLine.from + 2, to: lastLine.from + 3, class: 'cm-highlightFullWidthSpace' },
  ])
  assert.deepEqual(decorationRanges(plugins[0].decorations), [])
})

test('空白表示の切替は本文・コピー対象・選択範囲・Undo/Redoを維持する', () => {
  const { Compartment, EditorState, Transaction } = require('@codemirror/state')
  const { history, undo, redo } = require('@codemirror/commands')
  const { createWhitespaceExtensions } = loadSourceModule('src/editorWhitespace.ts')
  const whitespace = new Compartment()
  const text = '序章 \t　\n本文'
  const view = {
    state: EditorState.create({ doc: text, extensions: [history(), whitespace.of(createWhitespaceExtensions(false))] }),
    dispatch(transaction) {
      view.state = transaction instanceof Transaction ? transaction.state : view.state.update(transaction).state
    },
  }
  view.dispatch({ changes: { from: text.length, insert: '続き' }, selection: { anchor: 0, head: 6 } })
  const edited = view.state.doc.toString()
  const selection = view.state.selection
  const copyText = view.state.sliceDoc(selection.main.from, selection.main.to)
  for (const visible of [true, false, true, false]) {
    view.dispatch({ effects: whitespace.reconfigure(createWhitespaceExtensions(visible)) })
    assert.equal(view.state.doc.toString(), edited)
    assert.equal(view.state.selection.eq(selection), true)
    assert.equal(view.state.sliceDoc(selection.main.from, selection.main.to), copyText)
  }
  assert.equal(undo(view), true)
  assert.equal(view.state.doc.toString(), text)
  assert.equal(redo(view), true)
  assert.equal(view.state.doc.toString(), edited)
})

test('空白表示は設定窓との同期、保存後の再読込、Undo/Redo、初期化へ接続する', async () => {
  const { createDefaultApplicationPreferences, normalizeApplicationPreferences } = loadSourceModule('src/appPreferenceSchema.ts')
  const saved = []
  const snapshots = []
  let commandHandler
  const { useSettingsController } = loadSourceModule('src/useSettingsController.ts', {
    './appPreferences': {
      async saveSettingsPreferences(editor) { saved.push({ ...editor }) },
    },
    '@tauri-apps/api/event': {
      async emitTo(_label, event, payload) {
        if (event === 'editor-settings-flush-inputs') commandHandler({ payload: { type: 'inputs-flushed', requestId: payload.requestId } })
        else if (event === 'editor-settings-state') snapshots.push(payload)
      },
      async listen(_event, handler) { commandHandler = handler; return () => {} },
    },
    '@tauri-apps/api/webviewWindow': {
      WebviewWindow: class {
        /** 配信先が開いている状態を再現する。 */
        static async getByLabel() { return {} }
      },
    },
  })
  const controller = useSettingsController({
    initialPreferences: createDefaultApplicationPreferences(),
    showPersistenceNotice: assert.fail,
    showError: assert.fail,
  })
  try {
    await controller.setup()
    await commandHandler({ payload: { type: 'ready' } })
    await controller.toggleWhitespace()
    assert.equal(controller.editorSettings.value.showWhitespace, true)
    assert.equal(snapshots.at(-1).editor.showWhitespace, true)
    await commandHandler({ payload: { type: 'undo' } })
    assert.equal(controller.editorSettings.value.showWhitespace, false)
    await commandHandler({ payload: { type: 'redo' } })
    assert.equal(controller.editorSettings.value.showWhitespace, true)
    await controller.flush()
    assert.equal(normalizeApplicationPreferences({ editor: saved.at(-1) }).editor.showWhitespace, true)

    const { ref } = require('vue')
    const { useEditorSettingsDrafts } = loadSourceModule('src/useEditorSettingsDrafts.ts')
    const drafts = useEditorSettingsDrafts({
      snapshot: ref(snapshots.at(-1)),
      sendCommand: (payload) => commandHandler({ payload }),
    })
    drafts.restoreField('showWhitespace')
    assert.equal(controller.editorSettings.value.showWhitespace, false)
    await controller.flush()
    assert.equal(saved.at(-1).showWhitespace, false)
  } finally {
    await controller.dispose()
  }
})
