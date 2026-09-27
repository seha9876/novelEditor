/** 設定履歴、保存、window bridge、draftを検証する。 */
import {
  assert,
  deferred,
  loadSourceModule,
  require,
  test,
} from './test-support.mjs'

test('設定履歴moduleはセッション・上限・Undo/Redoを独立して管理する', () => {
  const preferences = loadSourceModule('src/appPreferenceSchema.ts')
  const { createSettingsHistory } = loadSourceModule('src/settingsHistory.ts')
  const defaults = preferences.createDefaultApplicationPreferences()
  const base = {
    editor: { ...defaults.editor },
    toolbar: { ...defaults.ui.toolbar, items: defaults.ui.toolbar.items.map((item) => ({ ...item })) },
    barSizes: { ...defaults.ui.barSizes },
  }
  const changed = { ...base, editor: { ...base.editor, fontSize: base.editor.fontSize + 1 } }
  const history = createSettingsHistory(1)
  history.beginSession()
  history.push(base)
  assert.equal(history.active, true)
  assert.equal(history.canUndo, true)
  assert.deepEqual(history.undo(changed), base)
  assert.equal(history.canRedo, true)
  assert.deepEqual(history.redo(base), changed)
  history.endSession()
  assert.equal(history.active, false)
  assert.equal(history.canUndo, false)
  assert.equal(history.canRedo, false)
})

test('設定保存moduleは変更を直列化し、失敗時に保存済み値へ戻す', async () => {
  const { useSettingsPersistence } = loadSourceModule('src/useSettingsPersistence.ts')
  let current = { value: 0 }
  let rejectNext = false
  const writes = []
  const rollbacks = []
  const persistence = useSettingsPersistence({
    clone: (value) => ({ ...value }),
    getSnapshot: () => current,
    save: async (snapshot) => {
      writes.push(snapshot.value)
      if (rejectNext) {
        rejectNext = false
        throw new Error('保存失敗')
      }
    },
    applyRollback: (snapshot) => { current = { ...snapshot } },
    notifyRollback: (error) => { rollbacks.push(String(error)) },
    notifyUnexpectedError: () => {},
    publishState: async () => {},
  })

  current = { value: 1 }
  persistence.markChanged()
  await persistence.flush()
  assert.deepEqual(writes, [1])
  current = { value: 2 }
  rejectNext = true
  persistence.markChanged()
  await persistence.flush()
  assert.deepEqual(current, { value: 1 })
  assert.deepEqual(rollbacks, ['Error: 保存失敗'])
  persistence.dispose()
})

test('設定channelはrevision順の状態だけを保持し、購読を破棄できる', async () => {
  const handlers = []
  const unlistenCounts = []
  const mocks = {
    '@tauri-apps/api/event': {
      async emitTo() {},
      async listen(_event, handler) {
        handlers.push(handler)
        const index = unlistenCounts.length
        unlistenCounts.push(0)
        return () => { unlistenCounts[index] += 1 }
      },
    },
  }
  const { useSettingsWindowChannel } = loadSourceModule('src/useSettingsWindowChannel.ts', mocks)
  const channel = useSettingsWindowChannel()
  await channel.setup()
  handlers[0]({ payload: { revision: 2, editor: {}, toolbar: {}, barSizes: {}, page: 'editor.wrapping', history: { canUndo: false, canRedo: false } } })
  handlers[0]({ payload: { revision: 1, editor: { stale: true }, toolbar: {}, barSizes: {}, page: 'editor.typography', history: { canUndo: true, canRedo: false } } })
  assert.equal(channel.snapshot.value.revision, 2)
  channel.dispose()
  assert.deepEqual(unlistenCounts, [1, 1])
})

test('本文設定draftは入力検証と保存待ち状態を実動作で同期する', async () => {
  const { ref } = require('vue')
  const { defaultEditorSettings } = loadSourceModule('src/editorSettings.ts')
  const { useEditorSettingsDrafts } = loadSourceModule('src/useEditorSettingsDrafts.ts')
  const snapshot = ref(null)
  const commands = []
  const drafts = useEditorSettingsDrafts({
    snapshot,
    sendCommand: async (command) => { commands.push(command) },
  })
  const state = {
    editor: { ...defaultEditorSettings },
    toolbar: { visible: true, items: [] },
    barSizes: { menu: 'medium', toolbar: 'medium', status: 'medium' },
    page: 'editor.wrapping',
    history: { canUndo: false, canRedo: false },
    revision: 1,
  }

  assert.equal(drafts.receiveSettingsSnapshot(state), true)
  drafts.onColumnsInput('0')
  assert.match(drafts.columnError.value, /1～500/)
  drafts.onColumnsInput('120')
  drafts.commitColumnsInput()
  await Promise.resolve()
  assert.deepEqual(commands, [{ type: 'change', editor: { wrapColumns: 120 }, flush: true }])

  const stale = { ...state, editor: { ...state.editor, wrapColumns: defaultEditorSettings.wrapColumns }, revision: 2 }
  assert.equal(drafts.receiveSettingsSnapshot(stale), true)
  assert.equal(drafts.columnsInput.value, '120')
  const confirmed = { ...stale, editor: { ...stale.editor, wrapColumns: 120 }, revision: 3 }
  drafts.receiveSettingsSnapshot(confirmed)
  assert.equal(drafts.columnsInput.value, '120')

  drafts.onTypographyInput('fontSize', 'bad')
  assert.match(drafts.typographyErrors.value.fontSize, /12～48/)
  drafts.onTypographyInput('fontSize', '22')
  drafts.commitTypographyInput('fontSize')
  await Promise.resolve()
  assert.deepEqual(commands.at(-1), { type: 'change', editor: { fontSize: 22 }, flush: true })
})

test('設定Controllerは変更を履歴化し、Undo/Redoと直列保存を実動作で接続する', async () => {
  const preferences = loadSourceModule('src/appPreferenceSchema.ts')
  const saved = []
  let commandHandler
  const mocks = {
    './appPreferences': {
      async saveSettingsPreferences(editor, toolbar, barSizes) { saved.push({ editor, toolbar, barSizes }) },
    },
    '@tauri-apps/api/event': {
      async emitTo() {},
      async listen(_event, handler) { commandHandler = handler; return () => {} },
    },
    '@tauri-apps/api/webviewWindow': {
      WebviewWindow: class {
        static async getByLabel() { return null }
      },
    },
  }
  const { useSettingsController } = loadSourceModule('src/useSettingsController.ts', mocks, new Map())
  const notices = []
  const controller = useSettingsController({
    initialPreferences: preferences.createDefaultApplicationPreferences(),
    showPersistenceNotice: (text) => notices.push(text),
    showError: async () => {},
  })

  assert.equal(controller.interfaceBarMetrics.value.menu.height, 48)
  await controller.setup()
  commandHandler({ payload: { type: 'ready' } })
  const originalSize = controller.editorSettings.value.fontSize
  commandHandler({ payload: { type: 'change', editor: { fontSize: originalSize + 1 } } })
  commandHandler({ payload: { type: 'undo' } })
  assert.equal(controller.editorSettings.value.fontSize, originalSize)
  commandHandler({ payload: { type: 'redo' } })
  assert.equal(controller.editorSettings.value.fontSize, originalSize + 1)
  await controller.flush()
  assert.equal(saved.at(-1).editor.fontSize, originalSize + 1)
  assert.deepEqual(notices, [])
  await controller.dispose()
})

test('設定Controllerは購読待ちの破棄後に遅着unlistenを即時実行し、多重setupを登録しない', async () => {
  const preferences = loadSourceModule('src/appPreferenceSchema.ts')
  const listenDeferred = deferred()
  let listenCount = 0
  let unlistenCount = 0
  const mocks = {
    './appPreferences': {
      async saveSettingsPreferences() {},
    },
    '@tauri-apps/api/event': {
      async emitTo() {},
      async listen() {
        listenCount += 1
        return listenDeferred.promise
      },
    },
    '@tauri-apps/api/webviewWindow': {
      WebviewWindow: class {
        static async getByLabel() { return null }
      },
    },
  }
  const { useSettingsController } = loadSourceModule('src/useSettingsController.ts', mocks, new Map())
  const controller = useSettingsController({
    initialPreferences: preferences.createDefaultApplicationPreferences(),
    showPersistenceNotice: () => {},
    showError: async () => {},
  })

  const firstSetup = controller.setup()
  const secondSetup = controller.setup()
  await controller.dispose()
  listenDeferred.release(() => { unlistenCount += 1 })
  await Promise.all([firstSetup, secondSetup])
  assert.equal(listenCount, 1)
  assert.equal(unlistenCount, 1)
})

test('設定Controllerは破棄中に遅着した設定窓取得から状態を配信しない', async () => {
  const preferences = loadSourceModule('src/appPreferenceSchema.ts')
  const listenHandlers = []
  const windowLookup = deferred()
  const emittedStates = []
  const mocks = {
    './appPreferences': {
      async saveSettingsPreferences() {},
    },
    '@tauri-apps/api/event': {
      async emitTo(_label, _event, payload) { emittedStates.push(payload) },
      async listen(_event, handler) {
        listenHandlers.push(handler)
        return () => {}
      },
    },
    '@tauri-apps/api/webviewWindow': {
      WebviewWindow: class {
        static async getByLabel() { return windowLookup.promise }
      },
    },
  }
  const { useSettingsController } = loadSourceModule('src/useSettingsController.ts', mocks, new Map())
  const controller = useSettingsController({
    initialPreferences: preferences.createDefaultApplicationPreferences(),
    showPersistenceNotice: () => {},
    showError: async () => {},
  })

  await controller.setup()
  const ready = listenHandlers[0]({ payload: { type: 'ready' } })
  await Promise.resolve()
  await controller.dispose()
  windowLookup.release({ setFocus: async () => {} })
  await ready

  assert.deepEqual(emittedStates, [])
})
