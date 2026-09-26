/** 設定スキーマ、既定値、表示プリセットを検証する。 */
import {
  assert,
  loadSourceModule,
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
  const presentation = loadSourceModule('src/interfaceBarPresentation.ts')
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
  const small = presentation.getInterfaceBarMetrics({ menu: 'small', toolbar: 'small', status: 'small' })
  const medium = presentation.getInterfaceBarMetrics({ menu: 'medium', toolbar: 'medium', status: 'medium' })
  const large = presentation.getInterfaceBarMetrics({ menu: 'large', toolbar: 'large', status: 'large' })
  assert.equal(small.menu.height, 40)
  assert.equal(small.toolbar.controlHeight, 36)
  assert.equal(small.toolbar.buttonHeight, 32)
  assert.equal(medium.toolbar.buttonHeight, 40)
  assert.equal(medium.toolbar.buttonWidth, 40)
  assert.equal(medium.toolbar.numberMenuWidth, 30)
  assert.equal(medium.toolbar.adjustButtonWidth, 32)
  assert.equal(large.toolbar.buttonHeight, 48)
  assert.equal(medium.toolbar.height, 60)
  assert.equal(large.status.height, 44)
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

test('バー表示moduleは個別サイズから高さとCSS変数を導出する', () => {
  const presentation = loadSourceModule('src/interfaceBarPresentation.ts')
  const sizes = { menu: 'small', toolbar: 'large', status: 'medium' }
  const metrics = presentation.getInterfaceBarMetrics(sizes)
  assert.equal(metrics.menu.height, 40)
  assert.equal(metrics.toolbar.height, 72)
  assert.equal(metrics.status.height, 36)
  assert.equal(presentation.getInterfaceBarHeight('toolbar', 'large'), 72)
  assert.equal(presentation.createInterfaceBarStyle(sizes)['--toolbar-bar-height'], '72px')
  assert.equal(presentation.createInterfaceBarStyle(sizes)['--menu-icon-size'], '18px')
})
