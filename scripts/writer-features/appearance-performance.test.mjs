/** 配色の連続操作で発生する描画・通信の回数と、最終値の保護を検証する。 */
import { assert, deferred, loadSourceModule, require, test } from './test-support.mjs'
const { nextTick } = require('vue')
const palette = loadSourceModule('src/appearance.ts')

/** 描画フレームだけを手動進行させ、時間に依存せず集約と期限を検証する。 */
function frames(t) {
  const previousRequest = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame
  const jobs = new Map(); let id = 0
  globalThis.requestAnimationFrame = callback => { jobs.set(++id, callback); return id }
  globalThis.cancelAnimationFrame = key => jobs.delete(key)
  t.after(() => { if (previousRequest) globalThis.requestAnimationFrame = previousRequest; else delete globalThis.requestAnimationFrame; if (previousCancel) globalThis.cancelAnimationFrame = previousCancel; else delete globalThis.cancelAnimationFrame })
  return async () => { const current = [...jobs.values()]; jobs.clear(); current.forEach(callback => callback()); for (let i = 0; i < 10; i++) await nextTick() }
}

/** 実際のController・両通信層を接続し、Tauriの配送とStoreだけを置き換える。 */
async function linkedSettings(t, extra = {}) {
  const tick = frames(t), handlers = new Map(), events = [], writes = [], errors = [], applied = []
  let fail = false, lookups = 0
  const nativeWindow = { once: async () => () => {}, setFocus: async () => {}, destroy: async () => {} }
  const mocks = {
    '@tauri-apps/api/event': {
      listen: async (name, receive) => { handlers.set(name, receive); return () => handlers.delete(name) },
      emitTo: async (target, name, payload) => {
        events.push({ target, name, payload })
        if (extra.send && name === 'editor-settings-command' && payload.type === 'appearance') await extra.send()
        handlers.get(name)?.({ payload: JSON.parse(JSON.stringify(payload)) })
      },
    },
    '@tauri-apps/api/webviewWindow': { WebviewWindow: class { static async getByLabel() { lookups++; return nativeWindow } } },
    './appearanceFile': {},
    './appPreferences': { saveSettingsPreferences: async (...values) => { if (fail) throw new Error('disk full'); writes.push(values) } },
  }
  const initial = loadSourceModule('src/appPreferenceSchema.ts').createDefaultApplicationPreferences()
  initial.ui.appearance.presets = Array.from({ length: 100 }, (_, i) => ({ id: `custom-${i}`, name: `色${i}`, colors: { ...initial.ui.appearance.colors } }))
  const main = loadSourceModule('src/useSettingsController.ts', mocks).useSettingsController({ initialPreferences: initial, onAppearanceChanged: colors => applied.push({ ...colors }), showError: assert.fail, showPersistenceNotice: error => errors.push(error) })
  const client = loadSourceModule('src/useSettingsWindowChannel.ts', mocks).useSettingsWindowChannel()
  t.after(async () => { client.dispose(); await main.dispose() })
  await main.setup(); await client.setup(); await main.openSettingsWindow('appearance.colors'); await client.sendCommand({ type: 'ready' })
  events.length = 0; lookups = 0
  return { main, client, events, writes, errors, applied, tick, handlers, lookups: () => lookups, fail: () => { fail = true } }
}

/** 一つのピッカー操作としてHEXを送る。 */
function color(value, interactionId = 'drag', key = 'editorBackground') { return { type: 'appearance', action: { type: 'color', key, value, interactionId } } }

test('120入力を1フレームにまとめ、本文・ルール・プリセットの参照と保存回数を保つ', async t => {
  const h = await linkedSettings(t)
  const editor = h.main.editorSettings.value, outline = h.main.outline.value, presets = h.main.appearance.value.presets
  const clientEditor = h.client.snapshot.value.editor, clientOutline = h.client.snapshot.value.outline, clientPresets = h.client.snapshot.value.appearance.presets
  for (let i = 1; i <= 120; i++) await h.client.sendCommand(color(`#${i.toString(16).padStart(6, '0')}`))
  assert.equal(h.events.length, 0); assert.equal(h.client.snapshot.value.appearance.colors.editorBackground, '#000078')
  await h.tick(); await h.tick()
  assert.equal(h.events.filter(event => event.name === 'editor-settings-command').length, 1)
  assert.equal(h.events.filter(event => event.name === 'editor-settings-color').length, 1)
  assert.equal(h.events.filter(event => event.name === 'editor-settings-state').length, 0)
  assert.equal(h.lookups(), 0); assert.equal(h.writes.length, 0)
  assert.equal(h.main.editorSettings.value, editor); assert.equal(h.main.outline.value, outline); assert.equal(h.main.appearance.value.presets, presets)
  assert.equal(h.client.snapshot.value.editor, clientEditor); assert.equal(h.client.snapshot.value.outline, clientOutline); assert.equal(h.client.snapshot.value.appearance.presets, clientPresets)
  await h.main.flush(); assert.equal(h.writes.length, 1)
  await h.client.sendCommand({ type: 'undo' }); assert.equal(h.main.appearance.value.colors.editorBackground, '#FFFFFF')
  assert.equal(h.client.snapshot.value.history.canUndo, false)
  await h.client.sendCommand({ type: 'redo' }); assert.equal(h.main.appearance.value.colors.editorBackground, '#000078')
})

test('通信待ちの中間色をためず、操作が変わると確定順とUndoの境界を保持する', async t => {
  const wait = deferred(); let count = 0
  const h = await linkedSettings(t, { send: async () => { if (++count === 1) await wait.promise } })
  await h.client.sendCommand(color('#112233')); await h.tick()
  for (const value of ['#223344', '#334455', '#445566']) await h.client.sendCommand(color(value))
  await h.client.sendCommand(color('#AABBCC', 'other', 'editorText'))
  wait.release(); await h.client.flush(); await h.tick()
  const commands = h.events.filter(event => event.name === 'editor-settings-command' && event.payload.type === 'appearance')
  assert.deepEqual(commands.map(event => event.payload.action.value), ['#112233', '#445566', '#AABBCC'])
  await h.client.sendCommand({ type: 'undo' }); assert.equal(h.main.appearance.value.colors.editorText, '#000000'); assert.equal(h.main.appearance.value.colors.editorBackground, '#445566')
  await h.client.sendCommand({ type: 'undo' }); assert.equal(h.main.appearance.value.colors.editorBackground, '#FFFFFF')
})

test('古い返信は最新入力を戻さず、保存失敗の復元後は旧世代の入力を拒否する', async t => {
  const h = await linkedSettings(t)
  await h.client.sendCommand(color('#112233')); await h.tick()
  await h.client.sendCommand(color('#223344'))
  await h.tick()
  assert.equal(h.client.snapshot.value.appearance.colors.editorBackground, '#223344')
  await h.main.flush(); await h.tick()
  const epoch = h.client.snapshot.value.appearanceEpoch
  h.fail(); await h.client.sendCommand(color('#334455', 'next')); await h.client.flush(); await h.main.flush()
  assert.equal(h.main.appearance.value.colors.editorBackground, '#223344')
  assert.equal(h.client.snapshot.value.appearance.colors.editorBackground, '#223344')
  assert.ok(h.errors.some(error => error.includes('保存できなかった')))
  h.handlers.get('editor-settings-command')({ payload: { ...color('#FFFFFF', 'old'), colorInput: { epoch, sequence: 999 } } })
  await nextTick(); assert.equal(h.main.appearance.value.colors.editorBackground, '#223344')
})

test('フレームが停止しても期限で最終色を反映し、破棄後は実行しない', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); frames(t)
  let count = 0
  const task = loadSourceModule('src/frameTask.ts').createFrameTask(() => { count++ })
  task.schedule(); task.schedule(); t.mock.timers.tick(49); assert.equal(count, 0)
  t.mock.timers.tick(1); assert.equal(count, 1)
  task.schedule(); task.dispose(); t.mock.timers.tick(50); assert.equal(count, 1)
})

test('表示適用は変更したCSSだけを書き、空白色以外ではSVGとテーマを変更しない', t => {
  const original = globalThis.document, writes = [], theme = { colors: {}, variables: {}, dark: false }
  globalThis.document = { documentElement: { style: { setProperty: (...args) => writes.push(args) } } }
  t.after(() => { if (original) globalThis.document = original; else delete globalThis.document })
  const apply = loadSourceModule('src/appearancePresentation.ts', { './vuetify': { vuetify: { theme: { themes: { value: { light: theme } } } } } }).applyAppearance
  const initial = palette.createDefaultAppearance().colors
  apply(initial); writes.length = 0
  const beforeTheme = JSON.stringify(theme)
  apply({ ...initial, editorText: '#123456' }); assert.deepEqual(writes.map(([key]) => key), ['--app-editorText']); assert.equal(JSON.stringify(theme), beforeTheme)
  writes.length = 0; apply({ ...initial, editorText: '#123456' }); assert.equal(writes.length, 0)
  apply({ ...initial, editorText: '#123456', whitespace: '#234567' }); assert.equal(writes.length, 4)
})

test('確定直後のページ移動と終了要求は、メインへの最終色反映を待つ', async t => {
  const h = await linkedSettings(t)
  await h.client.sendCommand(color('#123456'))
  await h.client.sendCommand({ type: 'navigate', page: 'editor.wrapping' })
  assert.equal(h.main.appearance.value.colors.editorBackground, '#123456')
  assert.equal(h.client.snapshot.value.page, 'editor.wrapping')
  await h.client.sendCommand(color('#234567', 'finish'))
  await h.main.flush()
  assert.equal(h.writes.at(-1)[4].colors.editorBackground, '#234567')
  assert.equal(h.events.at(-1).name, 'editor-settings-command')
})

test('送信失敗では未確認の最終色を残して通知し、明示的な再操作で送信を再試行する', async t => {
  let fail = true
  const h = await linkedSettings(t, { send: async () => { if (fail) throw new Error('通信不可') } })
  await h.client.sendCommand(color('#123456'))
  await assert.rejects(h.client.flush(), /通信不可/)
  assert.match(h.client.errorMessage.value, /送信できません/)
  assert.equal(h.main.appearance.value.colors.editorBackground, '#FFFFFF')
  fail = false
  await h.client.flush(); assert.equal(h.main.appearance.value.colors.editorBackground, '#123456')
})

test('同値入力は再保存やUndoを増やさず、不正HEXと古い返信は現在色を変更しない', async t => {
  const h = await linkedSettings(t)
  await h.client.sendCommand(color('#123456')); await h.main.flush(); await h.tick()
  const writeCount = h.writes.length
  await h.client.sendCommand(color('#123456', 'noop')); await h.main.flush(); assert.equal(h.writes.length, writeCount)
  await h.client.sendCommand(color('#12')); assert.match(h.client.errorMessage.value, /RRGGBB/)
  const old = h.events.find(event => event.name === 'editor-settings-color').payload
  await h.client.sendCommand(color('#234567', 'new')); await h.client.flush(); await h.tick()
  h.handlers.get('editor-settings-color')({ payload: old })
  assert.equal(h.client.snapshot.value.appearance.colors.editorBackground, '#234567')
  await h.client.sendCommand({ type: 'undo' }); await h.client.sendCommand({ type: 'undo' })
  assert.equal(h.main.appearance.value.colors.editorBackground, '#FFFFFF')
  assert.equal(h.client.snapshot.value.history.canUndo, false)
})

test('配色の配信中は中間通知を積まず、最新状態だけを次に配信する', async t => {
  const tick = frames(t), wait = deferred(), sent = [], applied = []
  const host = loadSourceModule('src/appearanceChannel.ts', { '@tauri-apps/api/event': { emit: async (_name, value) => { sent.push(value); if (sent.length === 1) await wait.promise } } }).createAppearanceHost(palette.createDefaultAppearance().colors, colors => applied.push(colors))
  t.after(host.dispose)
  host.update({ ...palette.createDefaultAppearance().colors, editorText: '#123456' }); await tick()
  host.update({ ...palette.createDefaultAppearance().colors, editorText: '#234567' }); await tick()
  host.update({ ...palette.createDefaultAppearance().colors, editorText: '#345678' }); await tick()
  assert.equal(sent.length, 1)
  wait.release(); await host.flush()
  assert.equal(sent.length, 2); assert.equal(sent[1].colors.editorText, '#345678'); assert.equal(applied.at(-1).editorText, '#345678')
})
