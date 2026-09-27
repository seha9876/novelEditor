/** ショートカットとツールバー表示の接続を検証する。 */
import {
  assert,
  loadSourceModule,
  readFileSync,
  projectRoot,
  resolve,
  test,
} from './test-support.mjs'

test('ショートカットはShiftとIME入力を正確に区別する', () => {
  const { findShortcutCommand } = loadSourceModule('src/appCommands.ts')
  const base = { key: 's', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }
  assert.equal(findShortcutCommand(base)?.id, 'document.save')
  assert.equal(findShortcutCommand({ ...base, key: 'S', shiftKey: true })?.id, 'document.saveAs')
  assert.equal(findShortcutCommand({ ...base, key: 'f' })?.id, 'edit.find')
  assert.equal(findShortcutCommand({ ...base, key: 'h' })?.id, 'edit.replace')
  assert.equal(findShortcutCommand({ ...base, altKey: true }), undefined)
  assert.equal(findShortcutCommand({ ...base, metaKey: true }), undefined)
  assert.equal(findShortcutCommand({ ...base, isComposing: true }), undefined)
})

test('ツールバーの本文書式操作はアイコンボタンだけで構成される', () => {
  const toolbar = readFileSync(resolve(projectRoot, 'src/EditorToolbar.vue'), 'utf8')
  const commands = readFileSync(resolve(projectRoot, 'src/appCommands.ts'), 'utf8')
  assert.doesNotMatch(toolbar, /VSelect|ToolbarTypographyNumber|toolbarFontItems|update-typography-number/)
  assert.doesNotMatch(commands, /toolbar\.typography\.fontFamily|toolbar\.typography\.fontSize'/)
  assert.match(toolbar, /class="toolbar-step-adjust" role="group" aria-label="行間を0\.1ずつ変更"/)
  assert.match(toolbar, /@click="emit\('adjust-line-height', -1\)"/)
  assert.match(toolbar, /@click="emit\('adjust-line-height', 1\)"/)
})

test('バーサイズ設定は設定画面・状態通信・メインレイアウトへ接続される', () => {
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const appBar = readFileSync(resolve(projectRoot, 'src/MainAppBar.vue'), 'utf8')
  const settingsController = readFileSync(resolve(projectRoot, 'src/useSettingsController.ts'), 'utf8')
  const settings = readFileSync(resolve(projectRoot, 'src/SettingsApp.vue'), 'utf8')
  const session = readFileSync(resolve(projectRoot, 'src/settingsSession.ts'), 'utf8')
  const definitions = readFileSync(resolve(projectRoot, 'src/settingsDefinitions.ts'), 'utf8')
  const appBarStyles = readFileSync(resolve(projectRoot, 'src/styles/app-bar.css'), 'utf8')
  const statisticsStyles = readFileSync(resolve(projectRoot, 'src/styles/statistics.css'), 'utf8')
  const styles = `${appBarStyles}\n${statisticsStyles}`
  const barPage = readFileSync(resolve(projectRoot, 'src/BarSizeSettingsPage.vue'), 'utf8')

  assert.match(appBar, /:height="props\.menuHeight"/)
  assert.match(appBar, /:extension-height="props\.toolbarHeight"/)
  assert.match(app, /<VApp[^>]*:style="interfaceBarStyle"/)
  assert.match(app, /:menu-height="interfaceBarMetrics\.menu\.height"/)
  assert.match(app, /:toolbar-height="interfaceBarMetrics\.toolbar\.height"/)
  assert.match(app, /:height="interfaceBarMetrics\.status\.height"/)
  assert.match(appBarStyles, /\.titlebar \.v-toolbar__content[^\n]*var\(--menu-bar-height/)
  assert.match(appBarStyles, /\.titlebar \.v-toolbar__extension[^\n]*var\(--toolbar-bar-height/)
  assert.doesNotMatch(appBarStyles, /\.titlebar \.v-toolbar__content[^\n]*align-items: flex-end/)
  assert.match(appBarStyles, /\.menu-bar[^\n]*height: 100%/)
  assert.match(appBarStyles, /\.menu-bar[^\n]*align-items: center/)
  assert.match(appBarStyles, /\.titlebar-drag-region[^\n]*height: 100%[^\n]*align-items: center/)
  assert.match(appBarStyles, /\.window-controls[^\n]*height: 100%/)
  assert.match(settingsController, /barSizes: \{ \.\.\.barSizes\.value \}/)
  assert.match(settings, /page\.id === 'appearance\.bars'/)
  assert.match(settings, /const barSizes = resetInterfaceBarSizes\(\)/)
  assert.match(session, /barSizes\?: Partial<InterfaceBarSizes>/)
  assert.match(definitions, /appearance\.bars\.sizes/)
  assert.match(barPage, /mandatory/)
  assert.match(styles, /toolbar-step-adjust \.v-btn\.v-btn--icon/)
  assert.doesNotMatch(styles, /toolbar-(?:control-height|input-font-size|label-font-size|font-width|number-width|number-menu-width)/)
  assert.match(styles, /statistics-button\.v-btn/)
  assert.match(styles, /height: var\(--status-bar-height, 36px\)/)
})

test('ステータスバー項目は保存順に描画し、設定画面だけを逆順で表示する', () => {
  const schema = readFileSync(resolve(projectRoot, 'src/appPreferenceSchema.ts'), 'utf8')
  const controller = readFileSync(resolve(projectRoot, 'src/useSettingsController.ts'), 'utf8')
  const settings = readFileSync(resolve(projectRoot, 'src/SettingsApp.vue'), 'utf8')
  const statusSettings = readFileSync(resolve(projectRoot, 'src/StatusBarSettingsPage.vue'), 'utf8')
  const statusView = readFileSync(resolve(projectRoot, 'src/StatisticsStatus.vue'), 'utf8')
  const ordering = readFileSync(resolve(projectRoot, 'src/statusBarOrdering.ts'), 'utf8')
  const styles = readFileSync(resolve(projectRoot, 'src/styles/statistics.css'), 'utf8')
  assert.match(schema, /type StatusBarItemId/)
  assert.match(schema, /createDefaultStatusBarPreferences/)
  for (const itemId of ['documentCharacters', 'selectionCharacters', 'position', 'lineCount', 'fontFamily', 'fontSize', 'lineHeight', 'wrapMode', 'statistics']) {
    assert.match(schema, new RegExp(`'${itemId}'`))
  }
  assert.match(controller, /normalizeStatusBarPreferences\(options\.initialPreferences\.ui\.statusBar\)/)
  assert.match(controller, /saveSettingsPreferences\(snapshot\.editor, snapshot\.toolbar, snapshot\.barSizes, snapshot\.statusBar\)/)
  assert.match(settings, /page\.id === 'appearance\.statusBar'/)
  assert.match(settings, /resetDialogOpen/)
  assert.match(settings, /statusBarResetDialog\.value/)
  assert.match(statusSettings, /resetStatusBar/)
  assert.match(statusSettings, /function addItem/)
  assert.match(statusSettings, /function removeItem/)
  assert.match(statusSettings, /function moveItem/)
  assert.match(statusSettings, /getStatusBarSettingsItems/)
  assert.match(statusSettings, /v-for="\(itemId, index\) in displayedItems"/)
  assert.match(ordering, /function getStatusBarSettingsItems/)
  assert.match(ordering, /function getStatusBarStoredItems/)
  assert.match(statusView, /v-for="item in items"/)
  assert.doesNotMatch(statusView, /renderedItems/)
  assert.match(statusView, /v-if="statistics\.error" class="statistics-warning" role="alert"/)
  assert.match(statusView, /:title="statistics\.error"/)
  assert.match(statusView, /editorSettings\.fontFamily/)
  assert.match(statusView, /item === 'selectionCharacters' && statistics\.selectionRanges/)
  assert.match(statusView, /item === 'statistics'/)
  assert.match(statusView, /formatWrapMode\(editorSettings\)/)
  assert.doesNotMatch(styles, /@container/)
  assert.doesNotMatch(styles, /\.statistics-position\s*\{\s*display:\s*none/)
  assert.doesNotMatch(styles, /\.statistics-total\s*\{\s*display:\s*none/)
})

test('ステータスバーの右クリックメニューから設定ページを開ける', () => {
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const readme = readFileSync(resolve(projectRoot, 'README.md'), 'utf8')

  assert.match(app, /const statusBarContextMenuOpen = ref\(false\)/)
  assert.match(app, /const statusBarContextMenuTarget = ref<\[number, number\]>\(\[0, 0\]\)/)
  assert.match(app, /function openStatusBarContextMenu\(event: MouseEvent\): void \{[\s\S]*?event\.preventDefault\(\)[\s\S]*?statusBarContextMenuTarget\.value = \[event\.clientX, event\.clientY\]/)
  assert.match(app, /function openStatusBarContextMenu\(event: MouseEvent\): void \{[\s\S]*?statusBarContextMenuOpen\.value = true/)
  assert.match(app, /class="status-bar"[^>]*@contextmenu="openStatusBarContextMenu"/)
  assert.match(app, /<VMenu v-model="statusBarContextMenuOpen" :target="statusBarContextMenuTarget" location="bottom start"/)
  assert.match(app, /<VList density="compact" min-width="240" role="menu" aria-label="ステータスバー操作">/)
  assert.match(app, /<VListItem role="menuitem" title="ステータスバーをカスタマイズ…" @click="openStatusBarSettings" \/>/)
  assert.match(app, /void openSettingsWindow\('appearance\.statusBar'\)/)
  assert.match(readme, /ステータスバーを右クリックして「ステータスバーをカスタマイズ…」を選ぶと/)
})

test('バーサイズの初期化範囲は全設定とツールバー構成で分離される', () => {
  const settings = readFileSync(resolve(projectRoot, 'src/SettingsApp.vue'), 'utf8')
  const settingsController = readFileSync(resolve(projectRoot, 'src/useSettingsController.ts'), 'utf8')
  const mediumPreset = readFileSync(resolve(projectRoot, 'src/interfaceBarPresentation.ts'), 'utf8')

  assert.match(settings, /const barSizes = resetInterfaceBarSizes\(\)/)
  assert.match(settings, /barSizes,\s*flush: true/)
  assert.match(settings, /const toolbar = resetToolbarPreferences\(snapshot\.value\.toolbar\)/)
  assert.doesNotMatch(settings.slice(settings.indexOf('function confirmToolbarDefaults'), settings.indexOf('/** 全設定初期化の確認画面を開く。')), /barSizes/)
  assert.match(settingsController, /function cloneCurrentSettings\(\): SettingsValues/)
  assert.match(settingsController, /updateCurrentSettings\(previous\.editor, previous\.toolbar, false, false, previous\.barSizes\)/)
  assert.match(settingsController, /updateCurrentSettings\(next\.editor, next\.toolbar, false, false, next\.barSizes\)/)
  assert.match(mediumPreset, /medium:\s*\{[\s\S]*?toolbar:\s*\{\s*height:\s*48,\s*buttonHeight:\s*40,\s*buttonWidth:\s*40,\s*iconSize:\s*20,[\s\S]*?padding:\s*4/)
})

test('ツールバーの文字サイズと行間調整は増減アイコンを使う', () => {
  const toolbar = readFileSync(resolve(projectRoot, 'src/EditorToolbar.vue'), 'utf8')
  const adjustment = toolbar.slice(toolbar.indexOf('toolbar.typography.fontSizeAdjust'), toolbar.indexOf('<VTooltip v-else'))
  assert.match(adjustment, /icon="mdi-format-font-size-decrease"/)
  assert.match(adjustment, /icon="mdi-format-font-size-increase"/)
  const lineHeightAdjustment = toolbar.slice(toolbar.indexOf('toolbar.typography.lineHeight'), toolbar.indexOf('<VTooltip v-else'))
  assert.match(lineHeightAdjustment, /icon="mdi-minus"/)
  assert.match(lineHeightAdjustment, /icon="mdi-plus"/)
  assert.equal((lineHeightAdjustment.match(/icon="mdi-format-line-spacing"/g) ?? []).length, 2)
  assert.equal((lineHeightAdjustment.match(/class="toolbar-step-primary-icon"[^>]*icon="mdi-format-line-spacing"[^>]*aria-hidden="true"/g) ?? []).length, 2)
  assert.match(lineHeightAdjustment, /class="toolbar-step-badge"[^>]*icon="mdi-minus"[^>]*aria-hidden="true"/)
  assert.match(lineHeightAdjustment, /class="toolbar-step-badge"[^>]*icon="mdi-plus"[^>]*aria-hidden="true"/)
  assert.match(lineHeightAdjustment, /lineHeight <= 1/)
  assert.match(lineHeightAdjustment, /lineHeight >= 3/)
  assert.match(lineHeightAdjustment, /aria-label="行間を0\.1狭くする"\s+title="行間を0\.1狭くする"/)
  assert.match(lineHeightAdjustment, /aria-label="行間を0\.1広くする"\s+title="行間を0\.1広くする"/)
  const styles = readFileSync(resolve(projectRoot, 'src/styles/app-bar.css'), 'utf8')
  assert.match(styles, /toolbar-composite-icon \.toolbar-step-badge\.v-icon/)
  assert.match(styles, /var\(--toolbar-icon-size, 20px\) \* 0\.72/)
  assert.match(styles, /var\(--toolbar-icon-size, 20px\) \* 0\.68/)
  const adjustStyle = styles.match(/\.toolbar-step-adjust \{[^}]+\}/)?.[0] ?? ''
  assert.match(adjustStyle, /height: var\(--toolbar-button-height, 40px\)/)
  assert.doesNotMatch(adjustStyle, /border(?:-radius)?\s*:/)
})

test('本文書式コントロールをツールバーへ一度ずつ登録でき、既定構成は維持する', () => {
  const commands = loadSourceModule('src/appCommands.ts')
  const preferences = loadSourceModule('src/appPreferenceSchema.ts')
  const typographyCommandIds = [
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
    { type: 'command', commandId: 'toolbar.typography.fontFamily' },
    { type: 'command', commandId: 'toolbar.typography.fontSize' },
    { type: 'separator', id: 'keep-this-separator' },
    ...typographyCommandIds.map((commandId) => ({ type: 'command', commandId })),
    { type: 'command', commandId: 'toolbar.typography.fontSizeAdjust' },
  ])
  assert.deepEqual(normalized, [
    { type: 'separator', id: 'keep-this-separator' },
    { type: 'command', commandId: 'toolbar.typography.fontSizeAdjust' },
    { type: 'command', commandId: 'toolbar.typography.lineHeight' },
  ])
  assert.deepEqual(preferences.normalizeToolbarItems([
    { type: 'command', commandId: 'toolbar.typography.fontFamily' },
    { type: 'command', commandId: 'toolbar.typography.fontSize' },
  ]), [])
})
