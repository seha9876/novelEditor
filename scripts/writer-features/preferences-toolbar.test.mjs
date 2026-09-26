/** エディター設定、バーサイズ、ツールバー構成と画面接続を検証する。 */
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

test('旧設定の補完は既存項目を保ち、任意の書体名と数値の境界を扱う', () => {
  const { defaultEditorSettings, normalizeEditorSettings, editorFontCss, isValidTypographyNumber, getTypographyNumberOptions } = loadSourceModule('src/editorSettings.ts')
  const old = normalizeEditorSettings({ wrapMode: 'columns', wrapColumns: 120, narrowWrapBehavior: 'fit' })
  assert.deepEqual(old, { ...defaultEditorSettings, wrapMode: 'columns', wrapColumns: 120, narrowWrapBehavior: 'fit' })
  const custom = normalizeEditorSettings({ ...old, fontFamily: '小説専用書体', fontFallback: 'sans-serif', fontSize: 48, lineHeight: 3 })
  assert.equal(custom.fontFamily, '小説専用書体')
  assert.equal(editorFontCss(custom), '"小説専用書体", sans-serif')
  assert.equal(editorFontCss({ fontFamily: 'A"B\\C', fontFallback: 'serif' }), '"A\\"B\\\\C", serif')
  for (const fontSize of [12, 18, 48]) assert.equal(isValidTypographyNumber('fontSize', fontSize), true)
  for (const fontSize of [11, 49, 18.5, NaN]) assert.equal(normalizeEditorSettings({ fontSize }).fontSize, 18)
  for (const lineHeight of [1, 1.1, 1.9, 3]) assert.equal(isValidTypographyNumber('lineHeight', lineHeight), true)
  for (const lineHeight of [0.9, 3.1, 1.95, Infinity]) assert.equal(normalizeEditorSettings({ lineHeight }).lineHeight, 1.9)
  const fontSizeOptions = getTypographyNumberOptions('fontSize')
  assert.equal(fontSizeOptions.length, 37)
  assert.deepEqual([fontSizeOptions[0], fontSizeOptions.at(-1)], [12, 48])
  assert.ok(fontSizeOptions.every((value) => isValidTypographyNumber('fontSize', value)))
  const lineHeightOptions = getTypographyNumberOptions('lineHeight')
  assert.equal(lineHeightOptions.length, 21)
  assert.deepEqual([lineHeightOptions[0], lineHeightOptions.at(-1)], [1, 3])
  assert.ok(lineHeightOptions.every((value) => isValidTypographyNumber('lineHeight', value)))
  assert.equal(normalizeEditorSettings({ fontFamily: 'bad\nfont', fontFallback: 'other' }).fontFamily, defaultEditorSettings.fontFamily)
})

test('ツールバー数値入力はIME変換中のEnterを確定キーと誤認しない', () => {
  const { shouldCommitTypographyInput } = loadSourceModule('src/editorSettings.ts')
  assert.equal(shouldCommitTypographyInput({ key: 'Enter', isComposing: false, keyCode: 13 }), true)
  assert.equal(shouldCommitTypographyInput({ key: 'Enter', isComposing: true, keyCode: 13 }), false)
  assert.equal(shouldCommitTypographyInput({ key: 'Enter', isComposing: false, keyCode: 229 }), false)
  assert.equal(shouldCommitTypographyInput({ key: 'Escape', isComposing: false, keyCode: 27 }), false)
})

test('プロジェクトツリー設定は旧データを補完し、保存幅を220～480pxに制限する', () => {
  const preferences = loadSourceModule('src/appPreferenceSchema.ts')
  const defaults = preferences.createDefaultApplicationPreferences()
  assert.deepEqual(defaults.ui.projectTree, { width: 280, detached: false })

  const old = preferences.normalizeApplicationPreferences({ schemaVersion: 1, ui: { toolbar: { visible: false } } })
  assert.deepEqual(old.ui.projectTree, { width: 280, detached: false })
  assert.equal(preferences.normalizeApplicationPreferences({ ui: { projectTree: { width: 200, detached: true } } }).ui.projectTree.width, 220)
  assert.equal(preferences.normalizeApplicationPreferences({ ui: { projectTree: { width: 700, detached: true } } }).ui.projectTree.width, 480)
  assert.deepEqual(preferences.normalizeApplicationPreferences({ ui: { projectTree: { width: 'wide', detached: 'yes' } } }).ui.projectTree, { width: 280, detached: false })
})

test('バーサイズ設定は旧データを中サイズで補完し、項目ごとの不正値だけを補正する', () => {
  const preferences = loadSourceModule('src/appPreferenceSchema.ts')
  assert.deepEqual(preferences.createDefaultApplicationPreferences().ui.barSizes, { menu: 'medium', toolbar: 'medium', status: 'medium' })
  assert.deepEqual(preferences.normalizeApplicationPreferences({ schemaVersion: 1, ui: { toolbar: { visible: false } } }).ui.barSizes, {
    menu: 'medium', toolbar: 'medium', status: 'medium',
  })
  assert.deepEqual(preferences.normalizeApplicationPreferences({ ui: {
    barSizes: { menu: 'small', toolbar: 'invalid', status: 'large' },
  } }).ui.barSizes, { menu: 'small', toolbar: 'medium', status: 'large' })
  assert.deepEqual(preferences.normalizeInterfaceBarSizes({ menu: 'large', status: null }), {
    menu: 'large', toolbar: 'medium', status: 'medium',
  })
  assert.equal(preferences.interfaceBarSizePresets.small.menu.height, 40)
  assert.equal(preferences.interfaceBarSizePresets.small.toolbar.controlHeight, 36)
  assert.equal(preferences.interfaceBarSizePresets.small.toolbar.buttonHeight, 32)
  assert.equal(preferences.interfaceBarSizePresets.medium.toolbar.buttonHeight, 40)
  assert.equal(preferences.interfaceBarSizePresets.medium.toolbar.buttonWidth, 40)
  assert.equal(preferences.interfaceBarSizePresets.medium.toolbar.numberMenuWidth, 30)
  assert.equal(preferences.interfaceBarSizePresets.medium.toolbar.adjustButtonWidth, 32)
  assert.equal(preferences.interfaceBarSizePresets.large.toolbar.buttonHeight, 48)
  assert.equal(preferences.interfaceBarSizePresets.medium.toolbar.height, 60)
  assert.equal(preferences.interfaceBarSizePresets.large.status.height, 44)
})

test('バーサイズ設定の保存はStoreへ正規化済みの実値を書き込む', async () => {
  let storedValue = {
    schemaVersion: 1,
    ui: {
      toolbar: { visible: true, items: [] },
      barSizes: { menu: 'small', toolbar: 'invalid', status: 'large' },
      projectTree: { width: 280, detached: false },
    },
  }
  let setCount = 0
  const store = {
    async get() { return storedValue },
    async set(_key, value) { storedValue = value; setCount += 1 },
    async save() {},
  }
  const mocks = { '@tauri-apps/plugin-store': { load: async () => store } }
  const cache = new Map()
  const storage = loadSourceModule('src/storageLocation.ts', mocks, cache)
  storage.setActiveStorageDirectory('C:\\bar-size-test')
  const preferences = loadSourceModule('src/appPreferences.ts', mocks, cache)
  const schema = loadSourceModule('src/appPreferenceSchema.ts', mocks, cache)
  const initialization = await preferences.initializeApplicationPreferences()
  assert.deepEqual(initialization.preferences.ui.barSizes, { menu: 'small', toolbar: 'medium', status: 'large' })

  await preferences.saveSettingsPreferences(
    initialization.preferences.editor,
    initialization.preferences.ui.toolbar,
    { menu: 'large', toolbar: 'not-a-size', status: 'small' },
  )
  assert.deepEqual(storedValue.ui.barSizes, { menu: 'large', toolbar: 'medium', status: 'small' })
  assert.ok(setCount >= 2)
  assert.equal(schema.normalizeInterfaceSize('not-a-size'), 'medium')
})

test('バーサイズとツールバー初期化の境界を純粋関数で保持する', () => {
  const preferences = loadSourceModule('src/appPreferenceSchema.ts')
  const source = {
    toolbar: { visible: false, items: [{ type: 'separator', id: 'custom-separator' }] },
    barSizes: { menu: 'small', toolbar: 'large', status: 'small' },
  }
  const clonedBarSizes = preferences.cloneInterfaceBarSizes(source.barSizes)
  clonedBarSizes.menu = 'large'
  const reset = preferences.resetInterfaceBarSizes()
  const toolbarReset = preferences.resetToolbarPreferences(source.toolbar)
  assert.equal(clonedBarSizes.menu, 'large')
  assert.equal(source.barSizes.menu, 'small')
  assert.deepEqual(reset, { menu: 'medium', toolbar: 'medium', status: 'medium' })
  assert.equal(toolbarReset.visible, false)
  assert.deepEqual(toolbarReset.items, preferences.createDefaultToolbarItems())
  assert.deepEqual(source.toolbar.items, [{ type: 'separator', id: 'custom-separator' }])
  assert.deepEqual(source.barSizes, { menu: 'small', toolbar: 'large', status: 'small' })
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

test('プロジェクトツリーStoreは初期読込と更新後再取得を実動作で直列化する', async () => {
  const { useProjectTreeStore } = loadSourceModule('src/useProjectTreeStore.ts')
  const snapshots = [
    { projects: [], nodes: [], activeProjectId: null },
    { projects: [{ id: 1, name: '作品' }], nodes: [], activeProjectId: 1 },
  ]
  let loadCount = 0
  let mutationCount = 0
  const refreshed = []
  const errors = []
  const store = useProjectTreeStore({
    loadSnapshot: async () => snapshots[Math.min(loadCount++, snapshots.length - 1)],
    canMutate: () => true,
    showError: async (error) => { errors.push(String(error)) },
    onSnapshotRefreshed: (snapshot) => { refreshed.push(snapshot) },
  })

  await store.initializeTree()
  assert.equal(store.loading.value, false)
  assert.equal(store.snapshot.value.activeProjectId, null)
  assert.equal(refreshed.length, 1)
  assert.equal(await store.runMutation(async () => { mutationCount += 1 }), true)
  assert.equal(mutationCount, 1)
  assert.equal(store.snapshot.value.activeProjectId, 1)
  assert.equal(store.mutationPending.value, false)
  assert.deepEqual(errors, [])
})

test('プロジェクトツリーStoreは破棄後の遅着DB結果と進捗表示を画面へ反映しない', async () => {
  const { useProjectTreeStore } = loadSourceModule('src/useProjectTreeStore.ts')
  const snapshotDeferred = deferred()
  const refreshed = []
  const errors = []
  const store = useProjectTreeStore({
    loadSnapshot: () => snapshotDeferred.promise,
    canMutate: () => true,
    showError: async (error) => { errors.push(String(error)) },
    onSnapshotRefreshed: (snapshot) => { refreshed.push(snapshot) },
  })

  const initialize = store.initializeTree()
  store.dispose()
  snapshotDeferred.release({ projects: [{ id: 1, name: '遅着' }], nodes: [], activeProjectId: 1 })
  await initialize
  assert.deepEqual(store.snapshot.value, { projects: [], nodes: [], activeProjectId: null })
  assert.deepEqual(refreshed, [])

  const mutationStore = useProjectTreeStore({
    loadSnapshot: async () => ({ projects: [], nodes: [], activeProjectId: null }),
    canMutate: () => true,
    showError: async (error) => { errors.push(String(error)) },
  })
  await mutationStore.initializeTree()
  const action = deferred()
  const mutation = mutationStore.runMutation(() => action.promise)
  mutationStore.dispose()
  action.release()
  assert.equal(await mutation, false)
  await new Promise((resolve) => globalThis.setTimeout(resolve, 300))
  assert.equal(mutationStore.delayedProgress.value, false)

  const rejectedStore = useProjectTreeStore({
    loadSnapshot: async () => ({ projects: [], nodes: [], activeProjectId: null }),
    canMutate: () => true,
    showError: async (error) => { errors.push(String(error)) },
  })
  await rejectedStore.initializeTree()
  const rejectedMutation = rejectedStore.runMutation(async () => {
    throw new Error('破棄後の遅着エラー')
  })
  rejectedStore.dispose()
  assert.equal(await rejectedMutation, false)
  assert.deepEqual(errors, [])

  const refreshDeferred = deferred()
  let refreshLoadCount = 0
  const refreshRaceStore = useProjectTreeStore({
    loadSnapshot: async () => refreshLoadCount++ === 0
      ? { projects: [], nodes: [], activeProjectId: null }
      : refreshDeferred.promise,
    canMutate: () => true,
    showError: async (error) => { errors.push(String(error)) },
  })
  await refreshRaceStore.initializeTree()
  const refreshMutation = refreshRaceStore.runMutation(async () => {})
  await Promise.resolve()
  refreshRaceStore.dispose()
  refreshDeferred.release({ projects: [], nodes: [], activeProjectId: 2 })
  assert.equal(await refreshMutation, false)
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

test('バーサイズ設定は設定画面・状態通信・メインレイアウトへ接続される', () => {
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const appBar = readFileSync(resolve(projectRoot, 'src/MainAppBar.vue'), 'utf8')
  const settingsController = readFileSync(resolve(projectRoot, 'src/useSettingsController.ts'), 'utf8')
  const settings = readFileSync(resolve(projectRoot, 'src/SettingsApp.vue'), 'utf8')
  const session = readFileSync(resolve(projectRoot, 'src/settingsSession.ts'), 'utf8')
  const definitions = readFileSync(resolve(projectRoot, 'src/settingsDefinitions.ts'), 'utf8')
  const styles = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')
  const barPage = readFileSync(resolve(projectRoot, 'src/BarSizeSettingsPage.vue'), 'utf8')

  assert.match(appBar, /:height="menuHeight"/)
  assert.match(appBar, /:extension-height="toolbarHeight"/)
  assert.match(app, /:height="interfaceBarMetrics\.status\.height"/)
  assert.match(settingsController, /barSizes: \{ \.\.\.barSizes\.value \}/)
  assert.match(settings, /page\.id === 'appearance\.bars'/)
  assert.match(settings, /const barSizes = resetInterfaceBarSizes\(\)/)
  assert.match(session, /barSizes\?: Partial<InterfaceBarSizes>/)
  assert.match(definitions, /appearance\.bars\.sizes/)
  assert.match(barPage, /mandatory/)
  assert.match(styles, /--toolbar-control-height/)
  assert.match(styles, /toolbar-typography-number-field\.v-input--density-compact \.v-field/)
  assert.match(styles, /toolbar-typography-number-menu\.v-btn\.v-btn--icon/)
  assert.match(styles, /statistics-button\.v-btn/)
  assert.match(styles, /height: var\(--status-bar-height, 36px\)/)
})

test('バーサイズの初期化範囲は全設定とツールバー構成で分離される', () => {
  const settings = readFileSync(resolve(projectRoot, 'src/SettingsApp.vue'), 'utf8')
  const settingsController = readFileSync(resolve(projectRoot, 'src/useSettingsController.ts'), 'utf8')
  const mediumPreset = readFileSync(resolve(projectRoot, 'src/appPreferenceSchema.ts'), 'utf8')

  assert.match(settings, /const barSizes = resetInterfaceBarSizes\(\)/)
  assert.match(settings, /barSizes,\s*flush: true/)
  assert.match(settings, /const toolbar = resetToolbarPreferences\(snapshot\.value\.toolbar\)/)
  assert.doesNotMatch(settings.slice(settings.indexOf('function confirmToolbarDefaults'), settings.indexOf('/** 全設定初期化の確認画面を開く。')), /barSizes/)
  assert.match(settingsController, /function cloneCurrentSettings\(\): SettingsValues/)
  assert.match(settingsController, /updateCurrentSettings\(previous\.editor, previous\.toolbar, false, false, previous\.barSizes\)/)
  assert.match(settingsController, /updateCurrentSettings\(next\.editor, next\.toolbar, false, false, next\.barSizes\)/)
  assert.match(mediumPreset, /medium:\s*\{[\s\S]*?menu: \{ height: 48, controlHeight: 28[\s\S]*?toolbar: \{ height: 60, controlHeight: 36, buttonHeight: 40, buttonWidth: 40/)
})

test('ツールバーの文字サイズ調整ボタンは増減内容を示すアイコンを使う', () => {
  const appBar = readFileSync(resolve(projectRoot, 'src/MainAppBar.vue'), 'utf8')
  const adjustment = appBar.slice(appBar.indexOf('toolbar-font-size-adjust'), appBar.indexOf('toolbar.typography.lineHeight'))
  assert.match(adjustment, /icon="mdi-format-font-size-decrease"/)
  assert.match(adjustment, /icon="mdi-format-font-size-increase"/)
  assert.doesNotMatch(adjustment, /icon="mdi-minus"/)
  assert.doesNotMatch(adjustment, /icon="mdi-plus"/)
})

test('本文書式コントロールをツールバーへ一度ずつ登録でき、既定構成は維持する', () => {
  const commands = loadSourceModule('src/appCommands.ts')
  const preferences = loadSourceModule('src/appPreferenceSchema.ts')
  const typographyCommandIds = [
    'toolbar.typography.fontFamily',
    'toolbar.typography.fontSize',
    'toolbar.typography.fontSizeAdjust',
    'toolbar.typography.lineHeight',
  ]
  const defaults = preferences.createDefaultToolbarItems()
  assert.deepEqual(defaults.map((item) => item.commandId ?? item.id), [
    'wrap.window', 'wrap.columns', 'wrap.none', 'separator-1', 'settings.open',
  ])
  assert.deepEqual(
    commands.getToolbarCommandDefinitions().filter((command) => typographyCommandIds.includes(command.id)).map((command) => command.id),
    typographyCommandIds,
  )

  const normalized = preferences.normalizeToolbarItems([
    ...typographyCommandIds.map((commandId) => ({ type: 'command', commandId })),
    { type: 'command', commandId: 'toolbar.typography.fontSize' },
  ])
  assert.deepEqual(normalized.map((item) => item.commandId), typographyCommandIds)
})
