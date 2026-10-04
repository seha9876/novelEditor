/** 配色の保存、履歴、共有ファイルとウィンドウ間の同期を検証する。 */
import { assert, deferred, loadSourceModule, test, TextDecoder, TextEncoder } from './test-support.mjs'

const appearance = loadSourceModule('src/appearance.ts')

test('旧設定は現行色を補完し、正常な配色は不要な保存を発生させない', () => {
  const schema = loadSourceModule('src/appPreferenceSchema.ts')
  const old = schema.normalizeApplicationPreferences({ schemaVersion: 1, editor: { fontSize: 28 } })
  assert.equal(old.editor.fontSize, 28)
  assert.deepEqual(old.ui.appearance, appearance.createDefaultAppearance())
  const customized = appearance.applyAppearanceAction(old.ui.appearance, { type: 'switch', id: 'builtin-dark' })
  old.ui.appearance = appearance.applyAppearanceAction(customized, { type: 'save', id: 'my-colors', name: '夜の執筆' })
  assert.equal(JSON.stringify(schema.normalizeApplicationPreferences(old)), JSON.stringify(old))
  const cloned = schema.cloneApplicationPreferences(old)
  cloned.ui.appearance.presets[0].colors.editorText = '#123456'
  assert.notEqual(old.ui.appearance.presets[0].colors.editorText, '#123456')
  const broken = appearance.normalizeAppearance({ colors: { editorText: '#abcdef', background: 'red' }, presets: [null], basePresetId: 'missing' })
  assert.equal(broken.colors.editorText, '#ABCDEF')
  assert.equal(broken.colors.background, '#FFFFFF')
  assert.equal(broken.basePresetId, null)
})

test('調整は保存済みプリセットと独立し、保存して切替・破棄して切替が一括適用される', () => {
  const initial = appearance.createDefaultAppearance()
  const edited = appearance.applyAppearanceAction(initial, { type: 'color', key: 'editorBackground', value: '#aabbcc' })
  assert.equal(appearance.isAppearanceModified(edited), true)
  assert.equal(initial.colors.editorBackground, '#FFFFFF')
  assert.equal(appearance.builtInPresets[0].colors.editorBackground, '#FFFFFF')
  assert.throws(() => appearance.applyAppearanceAction(edited, { type: 'save' }), /名前を付けて/)
  const saved = appearance.applyAppearanceAction(edited, { type: 'switch', id: 'builtin-dark', save: { name: '作業用', id: 'custom' } })
  assert.equal(saved.presets[0].colors.editorBackground, '#AABBCC')
  assert.equal(saved.basePresetId, 'builtin-dark')
  assert.equal(appearance.isAppearanceModified(saved), false)
  const restored = appearance.applyAppearanceAction(saved, { type: 'switch', id: 'custom' })
  const changed = appearance.applyAppearanceAction(restored, { type: 'color', key: 'editorText', value: '#123456' })
  assert.notEqual(changed.presets[0].colors.editorText, '#123456')
  const discarded = appearance.applyAppearanceAction(changed, { type: 'switch', id: 'builtin-sepia' })
  assert.deepEqual(discarded.presets, restored.presets)
  const overwritten = appearance.applyAppearanceAction(changed, { type: 'save' })
  assert.equal(overwritten.presets[0].colors.editorText, '#123456')
  assert.equal(appearance.isAppearanceModified(overwritten), false)
  assert.throws(() => appearance.applyAppearanceAction(changed, { type: 'switch', id: 'missing', save: {} }), /見つかりません/)
  assert.notEqual(changed.presets[0].colors.editorText, '#123456')
})

test('名前検証、標準配色の保護、使用中のプリセット削除後の現在色保持', () => {
  const initial = appearance.createDefaultAppearance()
  for (const name of ['', ' ', '現行色', '\n夜', 'あ'.repeat(81)]) {
    assert.throws(() => appearance.applyAppearanceAction(initial, { type: 'save', id: 'user', name }))
  }
  const saved = appearance.applyAppearanceAction(initial, { type: 'save', id: 'user', name: '作業用' })
  assert.throws(() => appearance.applyAppearanceAction(saved, { type: 'save', id: 'other', name: '作業用' }))
  assert.throws(() => appearance.applyAppearanceAction(saved, { type: 'delete', id: 'builtin-dark' }))
  assert.throws(() => appearance.applyAppearanceAction(saved, { type: 'rename', id: 'builtin-dark', name: '黒' }))
  const renamed = appearance.applyAppearanceAction(saved, { type: 'rename', id: 'user', name: ' 夜 ' })
  assert.equal(renamed.presets[0].name, '夜')
  const removed = appearance.applyAppearanceAction(renamed, { type: 'delete', id: 'user' })
  assert.deepEqual(removed.colors, renamed.colors)
  assert.equal(removed.basePresetId, null)
  assert.deepEqual(removed.presets, [])
})

test('共有JSONは全色を往復し、無関係なデータを含めず、不正値と未対応版を拒否する', () => {
  const source = appearance.builtInPresets[1]
  const json = appearance.exportColorPreset(source)
  assert.deepEqual(Object.keys(JSON.parse(json)), ['format', 'version', 'name', 'colors'])
  const imported = appearance.importColorPreset('\uFEFF' + json, 'imported-id')
  assert.deepEqual(imported.colors, source.colors)
  assert.equal(imported.id, 'imported-id')
  let current = appearance.applyAppearanceAction(appearance.createDefaultAppearance(), { type: 'import', preset: imported })
  assert.equal(current.presets[0].name, 'ダーク (2)')
  current = appearance.applyAppearanceAction(current, { type: 'import', preset: { ...imported, id: 'next-id' } })
  assert.equal(current.presets[1].name, 'ダーク (3)')
  assert.equal(current.basePresetId, 'builtin-light')
  assert.deepEqual(current.colors, appearance.createDefaultAppearance().colors)
  for (const invalid of ['{', 'null', '{}', JSON.stringify({ ...JSON.parse(json), version: 2 }), JSON.stringify({ ...JSON.parse(json), name: '' })]) {
    assert.throws(() => appearance.importColorPreset(invalid, 'id'))
  }
  for (const invalid of ['red', '#fff', '#12345678', 'url(https://example.com)', null, undefined]) {
    const data = JSON.parse(json)
    data.colors.editorText = invalid
    assert.throws(() => appearance.importColorPreset(JSON.stringify(data), 'id'))
  }
})

/** メイン窓の設定Controllerを実行し、永続化と子窓の入出力だけを差し替える。 */
async function controllerHarness(fileApi = {}) {
  let bridge
  let failSave = false
  const saved = []
  const applied = []
  const errors = []
  const schema = loadSourceModule('src/appPreferenceSchema.ts')
  const { useSettingsController } = loadSourceModule('src/useSettingsController.ts', {
    './appearanceFile': fileApi,
    './appPreferences': { async saveSettingsPreferences(editor, toolbar, barSizes, statusBar, colors) {
      if (failSave) throw new Error('disk full')
      saved.push({ editor, toolbar, barSizes, statusBar, appearance: appearance.cloneAppearance(colors) })
    } },
    './useSettingsWindowBridge': { useSettingsWindowBridge(options) {
      bridge = options
      return { settingsWindowOpen: { value: true }, async setup() {}, async dispose() {}, async publishState() {}, async publishError(message) { errors.push(message) } }
    } },
  })
  const controller = useSettingsController({
    initialPreferences: schema.createDefaultApplicationPreferences(),
    showPersistenceNotice: (message) => errors.push(message), showError: assert.fail,
    onAppearanceChanged: (colors) => applied.push({ ...colors }),
  })
  await controller.setup()
  await bridge.onCommand({ type: 'ready' })
  return { controller, saved, applied, errors, command: bridge.onCommand, snapshot: bridge.getSnapshot, failSave: () => { failSave = true } }
}

test('ピッカー連続入力は1回のUndoとなり、プリセット操作と初期化もUndo/Redoできる', async () => {
  const h = await controllerHarness()
  try {
    for (const value of ['#112233', '#223344', '#334455']) {
      await h.command({ type: 'appearance', action: { type: 'color', key: 'editorBackground', value, interactionId: 'drag-1' } })
    }
    assert.equal(h.applied.length, 3)
    await h.command({ type: 'undo' })
    assert.equal(h.controller.appearance.value.colors.editorBackground, '#FFFFFF')
    assert.equal(h.snapshot().history.canUndo, false)
    await h.command({ type: 'redo' })
    assert.equal(h.controller.appearance.value.colors.editorBackground, '#334455')
    await h.command({ type: 'appearance', action: { type: 'save', id: 'saved', name: '保存色' } })
    await h.controller.flush()
    assert.equal(h.saved.at(-1).appearance.presets[0].name, '保存色')
    await h.command({ type: 'change', resetAppearance: true, editor: { fontSize: 28 } })
    assert.equal(h.controller.appearance.value.basePresetId, 'builtin-light')
    assert.equal(h.controller.appearance.value.presets.length, 1)
    await h.command({ type: 'undo' })
    assert.equal(h.controller.appearance.value.basePresetId, 'saved')
    assert.equal(h.controller.editorSettings.value.fontSize, 18)
    await h.command({ type: 'undo' })
    assert.equal(h.controller.appearance.value.presets.length, 0)
    await h.command({ type: 'redo' })
    await h.controller.flush()
    const schema = loadSourceModule('src/appPreferenceSchema.ts')
    const restored = schema.normalizeApplicationPreferences({ ui: { appearance: h.saved.at(-1).appearance } })
    assert.deepEqual(restored.ui.appearance, h.snapshot().appearance)
  } finally { await h.controller.dispose() }
})

test('保存失敗では配色とプリセットを保存済み値へ戻し、同期先にも復元を通知する', async () => {
  const h = await controllerHarness()
  try {
    await h.command({ type: 'appearance', action: { type: 'switch', id: 'builtin-dark' } })
    await h.controller.flush()
    const persisted = appearance.cloneAppearance(h.controller.appearance.value)
    h.failSave()
    await h.command({ type: 'appearance', action: { type: 'save', id: 'new', name: '失敗する保存' } })
    await h.controller.flush()
    assert.deepEqual(h.snapshot().appearance, persisted)
    assert.deepEqual(h.applied.at(-1), persisted.colors)
    assert.equal(h.snapshot().history.canUndo, false)
    assert.match(h.errors.join('\n'), /保存できなかった/)
  } finally { await h.controller.dispose() }
})

test('ファイル操作の重複を防ぎ、取消・失敗で変更せず、登録しても自動適用しない', async () => {
  const pending = deferred()
  let calls = 0
  let result = null
  let failure = false
  const exported = []
  const h = await controllerHarness({ async readColorPreset() {
    calls += 1
    if (calls === 1) await pending.promise
    if (failure) throw new Error('読込失敗')
    return result
  }, async writeColorPreset(preset) { exported.push(preset) } })
  try {
    const first = h.command({ type: 'appearance-file', operation: 'import' })
    await h.command({ type: 'appearance-file', operation: 'import' })
    assert.equal(calls, 1)
    assert.equal(h.snapshot().appearanceFileBusy, true)
    pending.release()
    await first
    assert.equal(h.snapshot().history.canUndo, false)
    assert.equal(h.snapshot().appearanceFileBusy, false)
    failure = true
    await h.command({ type: 'appearance-file', operation: 'import' })
    assert.equal(h.snapshot().appearance.presets.length, 0)
    assert.match(h.errors.at(-1), /読込失敗/)
    failure = false
    result = { ...appearance.builtInPresets[2], id: 'imported' }
    await h.command({ type: 'appearance-file', operation: 'import' })
    assert.equal(h.snapshot().appearance.basePresetId, 'builtin-light')
    assert.equal(h.snapshot().appearance.presets.length, 1)
    await h.command({ type: 'appearance', action: { type: 'color', key: 'editorText', value: '#123456' } })
    await h.command({ type: 'appearance-file', operation: 'export', presetId: 'builtin-light' })
    assert.equal(exported[0].colors.editorText, appearance.builtInPresets[0].colors.editorText)
    await h.controller.flush()
  } finally { await h.controller.dispose() }
})

test('ファイル入出力は取消を許容し、UTF-8のJSONを読み書きする', async () => {
  let selectedPath = null
  let savedPath = null
  let bytes = new TextEncoder().encode(appearance.exportColorPreset(appearance.builtInPresets[1]))
  const writes = []
  let failWrite = false
  const files = loadSourceModule('src/appearanceFile.ts', {
    '@tauri-apps/plugin-dialog': { async open() { return selectedPath }, async save() { return savedPath } },
    '@tauri-apps/plugin-fs': { async readFile() { return bytes }, async writeFile(path, data) { if (failWrite) throw new Error('書込失敗'); writes.push({ path, data }) } },
  })
  assert.equal(await files.readColorPreset(), null)
  await files.writeColorPreset(appearance.builtInPresets[0])
  assert.equal(writes.length, 0)
  selectedPath = 'colors.json'
  assert.deepEqual((await files.readColorPreset()).colors, appearance.builtInPresets[1].colors)
  bytes = new Uint8Array([0xff])
  await assert.rejects(files.readColorPreset())
  savedPath = 'shared.json'
  await files.writeColorPreset(appearance.builtInPresets[2])
  assert.equal(writes[0].path, savedPath)
  assert.equal(new TextDecoder().decode(writes[0].data), appearance.exportColorPreset(appearance.builtInPresets[2]))
  failWrite = true
  await assert.rejects(files.writeColorPreset(appearance.builtInPresets[0]), /書込失敗/)
})

test('読込待ちの間の調整を保持して登録し、Controller破棄後の読込完了を無視する', async () => {
  const pending = deferred()
  const preset = { ...appearance.builtInPresets[1], id: 'late-import' }
  const h = await controllerHarness({ async readColorPreset() { await pending.promise; return preset } })
  try {
    const reading = h.command({ type: 'appearance-file', operation: 'import' })
    await h.command({ type: 'appearance', action: { type: 'color', key: 'editorText', value: '#123456' } })
    pending.release()
    await reading
    assert.equal(h.snapshot().appearance.colors.editorText, '#123456')
    assert.equal(h.snapshot().appearance.presets.length, 1)
    await h.controller.flush()
  } finally { await h.controller.dispose() }
  const afterClose = deferred()
  const closed = await controllerHarness({ async readColorPreset() { await afterClose.promise; return preset } })
  const reading = closed.command({ type: 'appearance-file', operation: 'import' })
  await closed.controller.dispose()
  afterClose.release()
  await reading
  assert.equal(closed.snapshot().appearance.presets.length, 0)
  assert.equal(closed.saved.length, 0)
})

test('表示への適用は全色のCSS変数・Vuetify・空白装飾を更新し、明暗を切り替える', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const variables = new Map()
  const style = { setProperty(key, value) { variables.set(key, value) }, colorScheme: '' }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { style } } })
  try {
    const theme = { colors: {}, variables: {}, dark: false }
    const presentation = loadSourceModule('src/appearancePresentation.ts', { './vuetify': { vuetify: { theme: { themes: { value: { light: theme } } } } } })
    for (const preset of appearance.builtInPresets) {
      presentation.applyAppearance(preset.colors)
      for (const key of appearance.colorKeys) assert.equal(variables.get(`--app-${key}`), preset.colors[key])
      assert.equal(theme.colors['on-primary'], preset.colors.onPrimary)
      assert.equal(theme.colors['on-surface'], preset.colors.text)
      assert.equal(theme.variables['border-color'], preset.colors.border)
      assert.equal(style.colorScheme, preset.id === 'builtin-dark' ? 'dark' : 'light')
      assert.match(decodeURIComponent(variables.get('--app-full-space-image')), new RegExp(preset.colors.whitespace))
    }
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

test('全窓と後から開いた窓へ同期し、古い通知と破棄後の通知を無視する', async () => {
  const handlers = new Map()
  const events = []
  const channel = loadSourceModule('src/appearanceChannel.ts', {
    '@tauri-apps/api/event': {
      async listen(name, handler) {
        const set = handlers.get(name) ?? new Set()
        set.add(handler)
        handlers.set(name, set)
        return () => set.delete(handler)
      },
      async emit(name, payload) {
        events.push(payload)
        for (const handler of handlers.get(name) ?? []) handler({ payload })
      },
      async emitTo(_target, name) { for (const handler of handlers.get(name) ?? []) handler({}) },
    },
  })
  const host = channel.createAppearanceHost(appearance.builtInPresets[0].colors, () => {})
  const received = []
  const client = channel.createAppearanceClient((colors) => received.push(colors))
  await host.setup()
  await client.setup()
  client.flush()
  host.update(appearance.builtInPresets[1].colors)
  await host.flush(); client.flush()
  assert.equal(received.length, 2)
  assert.deepEqual(received.at(-1), appearance.builtInPresets[1].colors)
  for (const handler of handlers.get(channel.APPEARANCE_STATE_EVENT)) handler({ payload: events[0] })
  assert.equal(received.length, 2)
  const late = []
  const lateClient = channel.createAppearanceClient((colors) => late.push(colors))
  await lateClient.setup()
  lateClient.flush()
  assert.deepEqual(late[0], appearance.builtInPresets[1].colors)
  assert.equal(received.length, 2)
  client.dispose()
  host.update(appearance.builtInPresets[2].colors)
  await host.flush(); lateClient.flush()
  assert.equal(received.length, 2)
  assert.equal(late.length, 2)
  lateClient.dispose()
  host.dispose()
  assert.equal([...handlers.values()].reduce((sum, set) => sum + set.size, 0), 0)
})

test('購読中の子窓破棄と、初期要求失敗後の再試行で購読を漏らさない', async () => {
  const pending = deferred()
  let removed = 0
  let failRequest = true
  const channel = loadSourceModule('src/appearanceChannel.ts', {
    '@tauri-apps/api/event': {
      async listen() { await pending.promise; return () => { removed += 1 } },
      async emitTo() { if (failRequest) throw new Error('接続失敗') },
    },
  })
  const client = channel.createAppearanceClient(assert.fail)
  const setup = client.setup()
  client.dispose()
  pending.release()
  await setup
  assert.equal(removed, 1)
  const retry = channel.createAppearanceClient(assert.fail)
  await assert.rejects(retry.setup(), /接続失敗/)
  assert.equal(removed, 2)
  failRequest = false
  await retry.setup()
  retry.dispose()
  assert.equal(removed, 3)
})
