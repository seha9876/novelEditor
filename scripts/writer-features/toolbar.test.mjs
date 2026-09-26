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

test('ツールバー数値入力はIME変換中のEnterを確定キーと誤認しない', () => {
  const { shouldCommitTypographyInput } = loadSourceModule('src/editorSettings.ts')
  assert.equal(shouldCommitTypographyInput({ key: 'Enter', isComposing: false, keyCode: 13 }), true)
  assert.equal(shouldCommitTypographyInput({ key: 'Enter', isComposing: true, keyCode: 13 }), false)
  assert.equal(shouldCommitTypographyInput({ key: 'Enter', isComposing: false, keyCode: 229 }), false)
  assert.equal(shouldCommitTypographyInput({ key: 'Escape', isComposing: false, keyCode: 27 }), false)
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
  const mediumPreset = readFileSync(resolve(projectRoot, 'src/interfaceBarPresentation.ts'), 'utf8')

  assert.match(settings, /const barSizes = resetInterfaceBarSizes\(\)/)
  assert.match(settings, /barSizes,\s*flush: true/)
  assert.match(settings, /const toolbar = resetToolbarPreferences\(snapshot\.value\.toolbar\)/)
  assert.doesNotMatch(settings.slice(settings.indexOf('function confirmToolbarDefaults'), settings.indexOf('/** 全設定初期化の確認画面を開く。')), /barSizes/)
  assert.match(settingsController, /function cloneCurrentSettings\(\): SettingsValues/)
  assert.match(settingsController, /updateCurrentSettings\(previous\.editor, previous\.toolbar, false, false, previous\.barSizes\)/)
  assert.match(settingsController, /updateCurrentSettings\(next\.editor, next\.toolbar, false, false, next\.barSizes\)/)
  assert.match(mediumPreset, /medium:\s*\{[\s\S]*?menu:\s*\{\s*height:\s*48,\s*controlHeight:\s*28[\s\S]*?toolbar:\s*\{\s*height:\s*60,\s*controlHeight:\s*36,\s*buttonHeight:\s*40,\s*buttonWidth:\s*40/)
})

test('ツールバーの文字サイズ調整ボタンは増減内容を示すアイコンを使う', () => {
  const toolbar = readFileSync(resolve(projectRoot, 'src/EditorToolbar.vue'), 'utf8')
  const adjustment = toolbar.slice(toolbar.indexOf('toolbar-font-size-adjust'), toolbar.indexOf('toolbar.typography.lineHeight'))
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
