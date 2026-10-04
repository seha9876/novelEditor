/** 行番号の設定互換性、本文保全、既存の設定保存・履歴経路を検証する。 */
import { assert, loadSourceModule, require, test } from './test-support.mjs'

test('行番号表示は旧設定でOFFとなり、boolean以外を受け付けない', () => {
  const { normalizeEditorSettings } = loadSourceModule('src/editorSettings.ts')
  for (const showLineNumbers of [undefined, null, 'true', 'false', 1, 0, {}, []]) {
    assert.equal(normalizeEditorSettings({ showLineNumbers }).showLineNumbers, false)
  }
  assert.equal(normalizeEditorSettings({ showLineNumbers: true }).showLineNumbers, true)
  assert.equal(normalizeEditorSettings({ showLineNumbers: false }).showLineNumbers, false)
})

test('行番号表示の切替は本文・コピー対象・選択範囲・Undo/Redoを維持する', () => {
  const { Compartment, EditorState, Transaction } = require('@codemirror/state')
  const { history, undo, redo } = require('@codemirror/commands')
  const { lineNumbers } = require('@codemirror/view')
  const lineNumberDisplay = new Compartment()
  const text = '序章 \t　\n本文'
  const view = {
    state: EditorState.create({ doc: text, extensions: [history(), lineNumberDisplay.of([])] }),
    dispatch(transaction) {
      view.state = transaction instanceof Transaction ? transaction.state : view.state.update(transaction).state
    },
  }
  view.dispatch({ changes: { from: text.length, insert: '続き' }, selection: { anchor: 0, head: 6 } })
  const edited = view.state.doc.toString()
  const selection = view.state.selection
  const copyText = view.state.sliceDoc(selection.main.from, selection.main.to)
  for (const visible of [true, false, true, false]) {
    view.dispatch({ effects: lineNumberDisplay.reconfigure(visible ? lineNumbers() : []) })
    assert.equal(view.state.doc.toString(), edited)
    assert.equal(view.state.selection.eq(selection), true)
    assert.equal(view.state.sliceDoc(selection.main.from, selection.main.to), copyText)
  }
  assert.equal(undo(view), true)
  assert.equal(view.state.doc.toString(), text)
  assert.equal(redo(view), true)
  assert.equal(view.state.doc.toString(), edited)
})

test('行番号表示は設定窓との同期、保存後の再読込、Undo/Redo、初期化へ接続する', async () => {
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
    await controller.toggleLineNumbers()
    assert.equal(controller.editorSettings.value.showLineNumbers, true)
    assert.equal(snapshots.at(-1).editor.showLineNumbers, true)
    await commandHandler({ payload: { type: 'undo' } })
    assert.equal(controller.editorSettings.value.showLineNumbers, false)
    await commandHandler({ payload: { type: 'redo' } })
    assert.equal(controller.editorSettings.value.showLineNumbers, true)
    await controller.flush()
    assert.equal(normalizeApplicationPreferences({ editor: saved.at(-1) }).editor.showLineNumbers, true)

    const { ref } = require('vue')
    const { useEditorSettingsDrafts } = loadSourceModule('src/useEditorSettingsDrafts.ts')
    const drafts = useEditorSettingsDrafts({
      snapshot: ref(snapshots.at(-1)),
      sendCommand: (payload) => commandHandler({ payload }),
    })
    drafts.restoreField('showLineNumbers')
    assert.equal(controller.editorSettings.value.showLineNumbers, false)
    await controller.flush()
    assert.equal(saved.at(-1).showLineNumbers, false)
  } finally {
    await controller.dispose()
  }
})
