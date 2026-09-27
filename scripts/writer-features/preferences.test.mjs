/** 設定スキーマ、既定値、表示プリセットを検証する。 */
import {
  assert,
  loadSourceModule,
  test,
} from './test-support.mjs'

test('旧設定の補完は既存項目を保ち、任意の書体名と数値の境界を扱う', () => {
  const { defaultEditorSettings, normalizeEditorSettings, editorFontCss, isValidTypographyNumber } = loadSourceModule('src/editorSettings.ts')
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

test('ステータスバー設定は旧データを既定値で補完し、不正値と重複だけを除去する', () => {
  const preferences = loadSourceModule('src/appPreferenceSchema.ts')
  const defaults = preferences.createDefaultApplicationPreferences().ui.statusBar
  assert.deepEqual(defaults.items, ['documentCharacters', 'selectionCharacters', 'position', 'statistics'])
  assert.deepEqual(
    preferences.normalizeApplicationPreferences({ schemaVersion: 1, ui: { toolbar: { visible: true } } }).ui.statusBar,
    defaults,
  )
  assert.deepEqual(
    preferences.normalizeStatusBarItems(['fontFamily', 'fontFamily', 'not-an-item', 'lineCount', null]),
    ['fontFamily', 'lineCount'],
  )
  assert.deepEqual(preferences.normalizeStatusBarItems(['statistics', 'fontFamily']), ['statistics', 'fontFamily'])
  assert.deepEqual(preferences.normalizeStatusBarItems([]), [])

  const source = { items: ['fontSize', 'wrapMode'] }
  const cloned = preferences.cloneStatusBarPreferences(source)
  cloned.items.push('statistics')
  assert.deepEqual(source.items, ['fontSize', 'wrapMode'])
  assert.deepEqual(preferences.resetStatusBarPreferences(), defaults)
})

test('ステータスバーの設定一覧は表示順を反転し、操作結果を保存順へ戻す', () => {
  const { getStatusBarSettingsItems, getStatusBarStoredItems, insertStatusBarItemAtSettingsIndex, removeStatusBarItemAtSettingsIndex, moveStatusBarItemAtSettingsIndex, reorderStatusBarItemsAtSettingsIndex } = loadSourceModule('src/statusBarOrdering.ts')
  const stored = ['documentCharacters', 'selectionCharacters', 'position']
  assert.deepEqual(getStatusBarSettingsItems(stored), ['position', 'selectionCharacters', 'documentCharacters'])
  assert.deepEqual(getStatusBarStoredItems(['position', 'selectionCharacters', 'documentCharacters']), stored)
  assert.deepEqual(insertStatusBarItemAtSettingsIndex(stored, 'statistics', 0), ['documentCharacters', 'selectionCharacters', 'position', 'statistics'])
  assert.deepEqual(removeStatusBarItemAtSettingsIndex(stored, 0), ['documentCharacters', 'selectionCharacters'])
  assert.deepEqual(moveStatusBarItemAtSettingsIndex(stored, 0, 1), ['documentCharacters', 'position', 'selectionCharacters'])
  assert.deepEqual(moveStatusBarItemAtSettingsIndex(stored, 2, -1), ['selectionCharacters', 'documentCharacters', 'position'])
  assert.deepEqual(reorderStatusBarItemsAtSettingsIndex(stored, 0, 2), ['position', 'documentCharacters', 'selectionCharacters'])
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
  assert.equal(preferences.normalizeInterfaceSize('extra-small'), 'medium')
  assert.equal(preferences.normalizeToolbarSize('extra-small'), 'extra-small')
  assert.deepEqual(preferences.normalizeInterfaceBarSizes({ menu: 'extra-small', toolbar: 'extra-small', status: 'extra-small' }), {
    menu: 'medium', toolbar: 'extra-small', status: 'medium',
  })
  const small = presentation.getInterfaceBarMetrics({ menu: 'small', toolbar: 'small', status: 'small' })
  const medium = presentation.getInterfaceBarMetrics({ menu: 'medium', toolbar: 'medium', status: 'medium' })
  const large = presentation.getInterfaceBarMetrics({ menu: 'large', toolbar: 'large', status: 'large' })
  assert.equal(small.menu.height, 28)
  assert.equal(small.menu.controlHeight, 24)
  assert.equal(small.menu.iconSize, 18)
  assert.equal(small.menu.buttonPadding, 8)
  assert.equal(medium.menu.height, 32)
  assert.equal(medium.menu.controlHeight, 28)
  assert.equal(medium.menu.iconSize, 20)
  assert.equal(medium.menu.buttonPadding, 12)
  assert.equal(large.menu.height, 40)
  assert.equal(large.menu.controlHeight, 36)
  assert.equal(large.menu.iconSize, 24)
  assert.equal(large.menu.buttonPadding, 16)
  assert.equal(small.toolbar.height, 40)
  assert.equal(small.toolbar.buttonHeight, 32)
  assert.equal(small.toolbar.iconSize, 18)
  assert.equal(small.toolbar.padding, 4)
  assert.equal(medium.toolbar.height, 48)
  assert.equal(medium.toolbar.buttonHeight, 40)
  assert.equal(medium.toolbar.buttonWidth, 40)
  assert.equal(medium.toolbar.iconSize, 20)
  assert.equal(medium.toolbar.padding, 4)
  assert.equal(large.toolbar.height, 56)
  assert.equal(large.toolbar.buttonHeight, 48)
  assert.equal(large.toolbar.iconSize, 24)
  assert.equal(large.toolbar.padding, 4)
  assert.equal(large.status.height, 44)
  const extraSmallToolbar = presentation.getInterfaceBarMetrics({ menu: 'small', toolbar: 'extra-small', status: 'small' }).toolbar
  assert.deepEqual(extraSmallToolbar, {
    height: 32,
    buttonHeight: 24,
    buttonWidth: 24,
    iconSize: 16,
    fontSize: '0.625rem',
    padding: 4,
    gap: 2,
    itemMargin: 0,
    dividerHeight: 16,
    dividerMargin: 2,
  })
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
    { menu: 'large', toolbar: 'extra-small', status: 'small' },
    { items: ['fontFamily', 'fontSize', 'statistics'] },
  )
  assert.deepEqual(storedValue.ui.barSizes, { menu: 'large', toolbar: 'extra-small', status: 'small' })
  assert.deepEqual(storedValue.ui.statusBar.items, ['fontFamily', 'fontSize', 'statistics'])
  assert.ok(setCount >= 2)
  assert.equal(schema.normalizeInterfaceSize('not-a-size'), 'medium')
  assert.equal(schema.normalizeToolbarSize('not-a-size'), 'medium')
})

test('バーサイズとツールバー初期化の境界を純粋関数で保持する', () => {
  const preferences = loadSourceModule('src/appPreferenceSchema.ts')
  const source = {
    toolbar: { visible: false, items: [{ type: 'separator', id: 'custom-separator' }] },
    barSizes: { menu: 'small', toolbar: 'extra-small', status: 'small' },
  }
  const clonedBarSizes = preferences.cloneInterfaceBarSizes(source.barSizes)
  clonedBarSizes.menu = 'large'
  const reset = preferences.resetInterfaceBarSizes()
  const toolbarReset = preferences.resetToolbarPreferences(source.toolbar)
  assert.equal(clonedBarSizes.menu, 'large')
  assert.equal(clonedBarSizes.toolbar, 'extra-small')
  assert.equal(source.barSizes.menu, 'small')
  assert.deepEqual(reset, { menu: 'medium', toolbar: 'medium', status: 'medium' })
  assert.equal(toolbarReset.visible, false)
  assert.deepEqual(toolbarReset.items, preferences.createDefaultToolbarItems())
  assert.deepEqual(source.toolbar.items, [{ type: 'separator', id: 'custom-separator' }])
  assert.deepEqual(source.barSizes, { menu: 'small', toolbar: 'extra-small', status: 'small' })
})

test('バー表示moduleは個別サイズから高さとCSS変数を導出する', () => {
  const presentation = loadSourceModule('src/interfaceBarPresentation.ts')
  const sizes = { menu: 'small', toolbar: 'large', status: 'medium' }
  const metrics = presentation.getInterfaceBarMetrics(sizes)
  assert.equal(metrics.menu.height, 28)
  assert.equal(metrics.toolbar.height, 56)
  assert.equal(metrics.status.height, 36)
  assert.equal(presentation.getInterfaceBarHeight('toolbar', 'large'), 56)
  assert.equal(presentation.getInterfaceBarHeight('toolbar', 'extra-small'), 32)
  assert.equal(presentation.createInterfaceBarStyle(sizes)['--toolbar-bar-height'], '56px')
  assert.equal(presentation.createInterfaceBarStyle(sizes)['--menu-icon-size'], '18px')
  const extraSmallStyle = presentation.createInterfaceBarStyle({ menu: 'small', toolbar: 'extra-small', status: 'medium' })
  assert.equal(extraSmallStyle['--toolbar-bar-height'], '32px')
  assert.equal(extraSmallStyle['--toolbar-button-height'], '24px')
  assert.equal(extraSmallStyle['--toolbar-button-width'], '24px')
  assert.equal(extraSmallStyle['--toolbar-icon-size'], '16px')
  assert.equal(extraSmallStyle['--toolbar-bar-padding'], '4px')
  assert.equal(extraSmallStyle['--toolbar-bar-gap'], '2px')
  assert.equal(extraSmallStyle['--toolbar-divider-height'], '16px')
  assert.equal(extraSmallStyle['--toolbar-divider-margin'], '2px')
})
