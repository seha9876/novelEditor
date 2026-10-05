/** アウトラインの移行・登録・Worker入力世代・共有ファイルを実処理で検証する。 */
import { assert, deferred, loadSourceModule, projectRoot, readFileSync, require, resolve, test, TextDecoder, TextEncoder, ts } from './test-support.mjs'
const vue = require('vue')
const outline = loadSourceModule('src/outline.ts')
const presets = loadSourceModule('src/outlinePresets.ts')

/** Vue購読とWorkerのPromiseを、実時間の待機なしで進める。 */
async function settle() { for (let index = 0; index < 15; index++) await vue.nextTick() }

test('旧設定の順序・無効状態・削除を保持し、標準と一致する場合だけ基準を補完する', () => {
  const defaults = outline.createDefaultOutline()
  assert.deepEqual(outline.normalizeOutline({ rules: defaults.rules }), defaults)
  const rules = outline.cloneOutlineRules(defaults).reverse().slice(1)
  rules[0].enabled = false; rules[0].level = 6
  assert.deepEqual(outline.normalizeOutline({ rules }), { rules, basePresetId: null, presets: [] })
  assert.deepEqual(outline.normalizeOutline({ rules: [] }), { rules: [], basePresetId: null, presets: [] })
  const saved = presets.applyOutlineAction(defaults, { type: 'save', id: 'empty', name: '見出しなし', rules: [] })
  assert.deepEqual(outline.normalizeOutline(saved), saved)
  const cloned = outline.cloneOutline(saved)
  cloned.presets[0].rules.push(defaults.rules[0]); cloned.rules.push(defaults.rules[1])
  assert.equal(saved.rules.length, 0); assert.equal(saved.presets[0].rules.length, 0)
  assert.equal(outline.extractOutline(outline.outlineExample, saved).length, 0)
})

test('ルール一式を独立して保存・上書き・切替し、標準プリセット自体は変更しない', () => {
  const start = outline.createDefaultOutline()
  const a = presets.applyOutlineAction(start, { type: 'save', id: 'a', name: '  章だけ  ', rules: start.rules.slice(1, 2) })
  assert.equal(a.presets[0].name, '章だけ'); assert.equal(start.presets.length, 0)
  const changed = presets.applyOutlineAction(a, { type: 'rules', rules: [] })
  assert.ok(presets.isOutlineModified(changed)); assert.equal(a.presets[0].rules.length, 1)
  const switched = presets.applyOutlineAction(changed, { type: 'switch', id: outline.STANDARD_OUTLINE_PRESET_ID, save: { rules: [] } })
  assert.equal(switched.presets[0].rules.length, 0)
  assert.deepEqual(switched.rules, start.rules)
  const renamed = presets.applyOutlineAction(switched, { type: 'rename', id: 'a', name: '空の一覧' })
  const selected = presets.applyOutlineAction(renamed, { type: 'switch', id: 'a' })
  const removed = presets.applyOutlineAction(selected, { type: 'delete', id: 'a' })
  assert.deepEqual(removed.rules, []); assert.equal(removed.basePresetId, null)
  assert.equal(removed.presets.length, 0)
  for (const action of [{ type: 'save' }, { type: 'delete', id: start.basePresetId }, { type: 'rename', id: start.basePresetId, name: '別名' }]) {
    assert.throws(() => presets.applyOutlineAction(start, action), /標準/)
  }
  assert.equal(presets.outlinePresetNameError(start, '標準'), '同じ名前のプリセットがあります。')
  for (const name of ['', '  ', 'a'.repeat(81), 'name\n']) assert.ok(presets.outlinePresetNameError(start, name))
  assert.deepEqual(presets.standardOutlinePreset.rules, start.rules)
})

test('JSONは全件を検証し、ルールIDは保持・登録IDは再発行・同名は調整する', () => {
  const original = presets.standardOutlinePreset
  const json = presets.exportOutlinePreset(original)
  const raw = JSON.parse(json)
  assert.deepEqual(Object.keys(raw), ['format', 'version', 'name', 'rules'])
  const imported = presets.importOutlinePreset('\uFEFF' + json, 'imported')
  assert.deepEqual(imported.rules, original.rules); assert.equal(imported.id, 'imported')
  const registered = presets.applyOutlineAction(outline.createDefaultOutline(), { type: 'import', preset: imported })
  assert.equal(registered.presets[0].name, '標準 (2)')
  assert.equal(registered.basePresetId, outline.STANDARD_OUTLINE_PRESET_ID)
  const twice = presets.applyOutlineAction(registered, { type: 'import', preset: { ...imported, id: 'second' } })
  assert.equal(twice.presets[1].name, '標準 (3)')
  for (const invalid of [
    { ...raw, format: 'novel-editor-color-preset' }, { ...raw, version: 2 }, { ...raw, name: '' },
    { ...raw, rules: null }, { ...raw, rules: [raw.rules[0], raw.rules[0]] },
    { ...raw, rules: [{ ...raw.rules[0], level: '2' }] }, { ...raw, rules: [{ ...raw.rules[0], enabled: 'true' }] },
    { ...raw, rules: [{ ...raw.rules[0], pattern: 'constructor' }] },
    { ...raw, rules: [{ ...raw.rules[0], kind: 'regexp', pattern: '[' }] },
    { ...raw, rules: [{ ...raw.rules[0], kind: 'numbered', pattern: '{番号}{番号}' }] },
  ]) assert.throws(() => presets.importOutlinePreset(JSON.stringify(invalid), 'new-id'))
  assert.throws(() => presets.importOutlinePreset('{', 'id'), /JSON/)
})

test('現在値と保存済み登録を再起動後も復元し、正常な設定を不要に書き直さない', async () => {
  const schema = loadSourceModule('src/appPreferenceSchema.ts')
  let stored = schema.createDefaultApplicationPreferences(), saves = 0
  const store = { reload: async () => {}, get: async () => stored, set: async (_key, next) => { stored = globalThis.structuredClone(next) }, save: async () => { saves++ } }
  const mocks = { './storageLocation': { getStorageFilePath: () => 'test-preferences.json' }, '@tauri-apps/plugin-fs': { exists: async () => true }, '@tauri-apps/plugin-store': { load: async () => store } }
  const storage = loadSourceModule('src/appPreferences.ts', mocks)
  await storage.initializeApplicationPreferences(); assert.equal(saves, 0)
  const saved = presets.applyOutlineAction(stored.outline, { type: 'save', id: 'saved', name: '空の見出し', rules: [] })
  const current = presets.applyOutlineAction(saved, { type: 'rules', rules: outline.createDefaultOutline().rules.slice(0, 1) })
  await storage.saveSettingsPreferences(stored.editor, stored.ui.toolbar, stored.ui.barSizes, stored.ui.statusBar, stored.ui.appearance, current)
  const restarted = await loadSourceModule('src/appPreferences.ts', mocks).initializeApplicationPreferences()
  assert.deepEqual(restarted.preferences.outline, current); assert.equal(saves, 1)
})

/** 保存・子窓通信だけを差し替え、実際の設定履歴と入力世代を動かす。 */
async function controllerHarness(t, fileApi = {}) {
  const saved = [], errors = [], exports = []
  let bridge, failSave = false
  const schema = loadSourceModule('src/appPreferenceSchema.ts')
  const module = loadSourceModule('src/useSettingsController.ts', {
    './outlinePresetFile': { readOutlinePreset: async () => null, writeOutlinePreset: async preset => exports.push(preset), ...fileApi },
    './appPreferences': { saveSettingsPreferences: async (_editor, _toolbar, _sizes, _status, _colors, next) => {
      if (failSave) throw new Error('disk full')
      saved.push(outline.cloneOutline(next))
    } },
    './useSettingsWindowBridge': { useSettingsWindowBridge: options => {
      bridge = options
      return { settingsWindowOpen: { value: true }, setup: async () => {}, dispose: async () => {}, publishState: async () => {}, publishError: async message => errors.push(message) }
    } },
  })
  const controller = module.useSettingsController({ initialPreferences: schema.createDefaultApplicationPreferences(), showPersistenceNotice: message => errors.push(message), showError: assert.fail })
  await controller.setup(); await bridge.onCommand({ type: 'ready' })
  t.after(() => controller.dispose())
  return { controller, saved, errors, exports, snapshot: bridge.getSnapshot, command: bridge.onCommand,
    action: action => bridge.onCommand({ type: 'outline', epoch: bridge.getSnapshot().outlineEpoch, action }),
    destroyed: () => bridge.onDestroyed(), failSave: () => { failSave = true } }
}

test('保存して切替は一回のUndoで登録も戻り、全設定初期化は登録を残す', async t => {
  const h = await controllerHarness(t)
  await h.action({ type: 'save', id: 'a', name: '設定A' }); await h.controller.flush()
  await h.action({ type: 'rules', rules: [] })
  const before = outline.cloneOutline(h.controller.outline.value)
  const rules = outline.createDefaultOutline().rules; rules[0].level = 4
  await h.action({ type: 'switch', id: outline.STANDARD_OUTLINE_PRESET_ID, save: { rules } })
  assert.equal(h.controller.outline.value.presets[0].rules[0].level, 4)
  await h.command({ type: 'undo' }); assert.deepEqual(h.controller.outline.value, before)
  await h.command({ type: 'redo' }); assert.equal(h.controller.outline.value.rules[0].level, 1)
  await h.action({ type: 'switch', id: 'a' })
  await h.command({ type: 'change', resetOutline: true, flush: true })
  assert.equal(h.controller.outline.value.basePresetId, outline.STANDARD_OUTLINE_PRESET_ID)
  assert.equal(h.controller.outline.value.presets[0].rules[0].level, 4)
  await h.controller.flush()
  assert.deepEqual(h.saved.at(-1), h.controller.outline.value)
})

test('切替・Undo・終了・保存失敗の前に送られた旧世代のルールは受け付けない', async t => {
  const h = await controllerHarness(t)
  const stale = { type: 'outline', epoch: h.snapshot().outlineEpoch, action: { type: 'rules', rules: [] } }
  await h.action({ type: 'switch', id: outline.STANDARD_OUTLINE_PRESET_ID }); await h.command(stale)
  assert.equal(h.controller.outline.value.rules.length, 4)
  await h.action({ type: 'save', id: 'a', name: '登録' }); await h.controller.flush()
  const beforeUndo = h.snapshot().outlineEpoch
  await h.command({ type: 'undo' }); await h.command({ ...stale, epoch: beforeUndo })
  assert.equal(h.controller.outline.value.rules.length, 4)
  const beforeClose = h.snapshot().outlineEpoch
  h.destroyed(); await h.command({ ...stale, epoch: beforeClose })
  assert.equal(h.controller.outline.value.rules.length, 4)
  await h.controller.flush()
  const baseline = outline.cloneOutline(h.controller.outline.value), beforeFailure = h.snapshot().outlineEpoch
  h.failSave(); await h.action({ type: 'save', id: 'bad', name: '保存失敗', rules: [] }); await h.controller.flush()
  assert.deepEqual(h.controller.outline.value, baseline)
  await h.command({ ...stale, epoch: beforeFailure })
  assert.deepEqual(h.controller.outline.value, baseline)
  assert.ok(h.errors.some(error => error.includes('直近の保存内容')))
})

test('読込中は多重実行せず、Undoや窓終了後の読込完了を登録しない', async t => {
  const waiting = deferred(), signals = []
  const h = await controllerHarness(t, { readOutlinePreset: async signal => { signals.push(signal); return waiting.promise } })
  const job = h.command({ type: 'outline-file', operation: 'import' }); await settle()
  assert.equal(h.snapshot().outlineFileBusy, true)
  await h.command({ type: 'outline-file', operation: 'import' }); assert.equal(signals.length, 1)
  await h.command({ type: 'undo' }); assert.equal(signals[0].aborted, true)
  h.destroyed()
  waiting.release({ ...presets.standardOutlinePreset, id: 'late' }); await job
  assert.equal(h.controller.outline.value.presets.length, 0); assert.equal(h.snapshot().outlineFileBusy, false)
})

test('読込は適用せず登録だけ行い、書き出しは調整中の値ではなく保存済みの値を使う', async t => {
  let result = null
  const h = await controllerHarness(t, { readOutlinePreset: async () => result })
  await h.command({ type: 'outline-file', operation: 'import' })
  assert.equal(h.snapshot().history.canUndo, false)
  result = { id: 'imported', name: '別の設定', rules: [] }
  await h.command({ type: 'outline-file', operation: 'import' })
  assert.equal(h.controller.outline.value.basePresetId, outline.STANDARD_OUTLINE_PRESET_ID)
  assert.equal(h.controller.outline.value.presets.length, 1)
  await h.action({ type: 'rules', rules: [] })
  await h.command({ type: 'outline-file', operation: 'export', presetId: outline.STANDARD_OUTLINE_PRESET_ID })
  assert.equal(h.exports[0].rules.length, 4); assert.equal(h.controller.outline.value.rules.length, 0)
  await h.command({ type: 'undo' }); await h.command({ type: 'undo' })
  assert.equal(h.controller.outline.value.presets.length, 0)
})

/** 下書き処理へWorkerだけを差し替え、遅着した確認値や判定結果を検証する。 */
function draftHarness(t, analyze = async request => outline.extractOutline(request.text, request.preferences)) {
  const state = vue.reactive({ preferences: outline.createDefaultOutline(), epoch: 0 }), emitted = [], requests = []
  const module = loadSourceModule('src/useOutlineRuleDraft.ts', { './sidebarWorker': { runSidebarAnalysis: async (request, signal) => { requests.push(request); return analyze(request, signal) } } })
  const scope = vue.effectScope()
  const draft = scope.run(() => module.useOutlineRuleDraft({ preferences: () => state.preferences, epoch: () => state.epoch, publish: (rules, epoch) => emitted.push({ rules, epoch }) }))
  t.after(() => { draft.dispose(); scope.stop() })
  return { state, draft, emitted, requests }
}

test('名称・登録一覧・同値返信では未完成の下書きを消さず、自分の遅い確認値も無視する', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = draftHarness(t)
  h.draft.draft.value.rules[0].level = 4; h.draft.change()
  t.mock.timers.tick(200); await settle()
  h.draft.draft.value.rules.unshift({ id: 'new', name: '新規', enabled: true, level: 2, kind: 'affix', prefix: '', suffix: '', pattern: '' }); h.draft.change()
  h.state.preferences = presets.applyOutlineAction(h.state.preferences, { type: 'rules', rules: h.emitted[0].rules })
  await settle(); assert.equal(h.draft.draft.value.rules.length, 5)
  h.state.preferences = presets.applyOutlineAction(h.state.preferences, { type: 'save', id: 'saved', name: '保存' })
  await settle(); assert.equal(h.draft.draft.value.rules.length, 5)
  h.state.preferences = presets.applyOutlineAction(h.state.preferences, { type: 'rename', id: 'saved', name: '別名' })
  await settle(); assert.equal(h.draft.draft.value.rules.length, 5)
  t.mock.timers.tick(200); await settle(); assert.equal(h.emitted.length, 1)
  assert.ok(h.draft.previewError.value); assert.ok(h.requests.every(request => !('presets' in request.preferences)))
})

test('ルールの欄の並び方による差を無視し、削除した空配列も自動反映する', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = draftHarness(t)
  h.draft.draft.value.rules = []
  h.draft.change(); t.mock.timers.tick(200); await settle()
  assert.deepEqual(h.emitted[0].rules, [])
  const defaults = outline.createDefaultOutline()
  const reorderedFields = { ...defaults, rules: defaults.rules.map(rule => ({ suffix: rule.suffix, ...rule })) }
  assert.equal(outline.outlineRulesSignature(reorderedFields), outline.outlineRulesSignature(defaults))
  assert.equal(presets.isOutlineModified(reorderedFields), false)
})

test('保存用判定は即時反映と分離でき、不正入力・時間超過・旧世代・破棄後は送信しない', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const waiting = deferred()
  const h = draftHarness(t, async () => waiting.promise)
  h.draft.draft.value.rules[0].level = 4; h.draft.change()
  const job = h.draft.validate()
  h.state.epoch++; await settle(); waiting.release([])
  assert.equal(await job, null); assert.equal(h.emitted.length, 0)
  const invalid = draftHarness(t)
  invalid.draft.draft.value.rules[0].level = 7; invalid.draft.change()
  assert.equal(await invalid.draft.validate(), null)
  const timed = draftHarness(t, async () => { throw new Error('解析に時間がかかりすぎています。') })
  timed.draft.change(); assert.equal(await timed.draft.validate(), null)
  assert.match(timed.draft.previewError.value, /時間/); assert.equal(timed.emitted.length, 0)
  const ok = draftHarness(t)
  ok.draft.draft.value.rules[0].level = 5; ok.draft.change()
  assert.equal((await ok.draft.validate())[0].level, 5); assert.equal(ok.emitted.length, 0)
  ok.draft.dispose(); t.mock.timers.tick(200); await settle(); assert.equal(ok.emitted.length, 0)
})

test('ファイル境界はUTF-8・BOM・Worker確認を通し、取消・不正・時間超過を登録しない', async () => {
  let path = null, destination = null, failure = false
  let bytes = new TextEncoder().encode('\uFEFF' + presets.exportOutlinePreset(presets.standardOutlinePreset))
  const requests = [], writes = []
  const file = loadSourceModule('src/outlinePresetFile.ts', {
    '@tauri-apps/plugin-dialog': { open: async () => path, save: async () => destination },
    '@tauri-apps/plugin-fs': { readFile: async () => bytes, writeFile: async (filePath, data) => writes.push({ filePath, data }) },
    './sidebarWorker': { runSidebarAnalysis: async request => { requests.push(request); if (failure) throw new Error('判定に時間がかかりすぎています。'); return [] } },
  })
  assert.equal(await file.readOutlinePreset(), null); assert.equal(requests.length, 0)
  await file.writeOutlinePreset(presets.standardOutlinePreset); assert.equal(writes.length, 0)
  path = 'preset.json'
  const loaded = await file.readOutlinePreset(); assert.deepEqual(loaded.rules, presets.standardOutlinePreset.rules)
  assert.equal(requests.length, 1); assert.deepEqual(Object.keys(requests[0].preferences), ['rules'])
  failure = true; await assert.rejects(file.readOutlinePreset(), /時間/)
  failure = false; bytes = new Uint8Array([255]); await assert.rejects(file.readOutlinePreset())
  bytes = new TextEncoder().encode('{'); await assert.rejects(file.readOutlinePreset(), /JSON/)
  destination = 'saved.json'; await file.writeOutlinePreset(presets.standardOutlinePreset)
  assert.equal(new TextDecoder().decode(writes[0].data), presets.exportOutlinePreset(presets.standardOutlinePreset))
})

test('ファイルの読み書き失敗は設定と履歴を変えず、処理中の表示を解除する', async t => {
  const h = await controllerHarness(t, { readOutlinePreset: async () => { throw new Error('read failed') }, writeOutlinePreset: async () => { throw new Error('write failed') } })
  const before = outline.cloneOutline(h.controller.outline.value)
  await h.command({ type: 'outline-file', operation: 'import' })
  await h.command({ type: 'outline-file', operation: 'export', presetId: before.basePresetId })
  assert.deepEqual(h.controller.outline.value, before)
  assert.equal(h.snapshot().outlineFileBusy, false); assert.equal(h.snapshot().history.canUndo, false)
  assert.deepEqual(h.errors, ['Error: read failed', 'Error: write failed'])
})

/** 実際の設定ページの操作を実行し、表示のマクロとWorkerだけを差し替える。 */
function pageHarness(t, analyze = async request => outline.extractOutline(request.text, request.preferences)) {
  const props = vue.reactive({ preferences: outline.createDefaultOutline(), epoch: 0, fileBusy: false }), commands = [], cleanup = []
  const draftModule = loadSourceModule('src/useOutlineRuleDraft.ts', { './sidebarWorker': { runSidebarAnalysis: analyze } })
  const source = readFileSync(resolve(projectRoot, 'src/OutlineSettingsPage.vue'), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const scope = vue.effectScope()
  const page = scope.run(() => new Function('require', 'exports', 'defineProps', 'defineEmits', `${compiled}; return { draft, dialog, presetName, change, remove, choosePreset, switchPreset, openNameDialog, confirmName, overwrite, closeDialog }`)(specifier => {
    if (specifier === 'vue') return { ...vue, onBeforeUnmount: callback => cleanup.push(callback) }
    if (specifier === './outline') return outline
    if (specifier === './outlinePresets') return presets
    if (specifier === './useOutlineRuleDraft') return draftModule
    throw new Error(specifier)
  }, {}, () => props, () => (event, command) => {
    if (event !== 'command') return
    commands.push(command)
    if (command.type === 'outline') {
      props.preferences = presets.applyOutlineAction(props.preferences, command.action)
      if (command.action.type === 'switch') props.epoch++
    }
  }))
  t.after(() => { cleanup.forEach(callback => callback()); scope.stop() })
  return { props, commands, page }
}

test('設定ページは標準ルールも削除し、保存・切替・未完成入力の破棄を実行する', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = pageHarness(t)
  h.page.remove(0); t.mock.timers.tick(200); await settle()
  assert.equal(h.props.preferences.rules.length, 3)
  h.page.openNameDialog('save'); h.page.presetName.value = '章と節'
  await h.page.confirmName(); await settle()
  const id = h.props.preferences.basePresetId
  assert.notEqual(id, outline.STANDARD_OUTLINE_PRESET_ID)
  assert.equal(h.props.preferences.presets[0].rules.length, 3)
  h.page.draft.value.rules[0].level = 7; h.page.change()
  h.page.choosePreset(outline.STANDARD_OUTLINE_PRESET_ID)
  await h.page.switchPreset(true); assert.equal(h.page.dialog.value, 'switch')
  assert.equal(h.props.preferences.basePresetId, id)
  await h.page.switchPreset(false); await settle()
  assert.equal(h.props.preferences.rules.length, 4); assert.equal(h.page.dialog.value, null)
  assert.ok(h.commands.every(command => command.type === 'outline'))
})

test('名前入力を取り消した後に判定が完了しても、プリセット保存を送らない', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const waiting = deferred(), h = pageHarness(t, async () => waiting.promise)
  h.page.openNameDialog('save'); h.page.presetName.value = '取り消す保存'
  const job = h.page.confirmName(); h.page.closeDialog(); waiting.release([]); await job
  assert.equal(h.commands.length, 0); assert.equal(h.props.preferences.presets.length, 0)
})

/** 表示パネルの実購読を動かし、本文APIは読取と移動だけを許す。 */
function panelHarness(t, analyze = async request => outline.extractOutline(request.text, request.preferences)) {
  const document = Object.freeze({ text: outline.outlineExample, revision: 1 }), requests = [], navigations = [], cleanup = []
  const props = vue.reactive({ active: true, revision: 1, head: 0, documentKey: 'manuscript', disabled: false,
    preferences: outline.createDefaultOutline(), editor: { getDocumentSnapshot: () => document, revealRange: target => { navigations.push(target); return true } } })
  const source = readFileSync(resolve(projectRoot, 'src/OutlinePanel.vue'), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const scope = vue.effectScope()
  const panel = scope.run(() => new Function('require', 'exports', 'defineProps', 'defineEmits', `${compiled}; return { headings, pending, stale }`)(specifier => {
    if (specifier === 'vue') return { ...vue, onBeforeUnmount: callback => cleanup.push(callback) }
    if (specifier === './outline') return outline
    if (specifier === './sidebarWorker') return { runSidebarAnalysis: (request, signal) => { requests.push({ request, signal }); return analyze(request, signal) } }
    throw new Error(specifier)
  }, {}, () => props, () => () => {}))
  t.after(() => { cleanup.forEach(callback => callback()); scope.stop() })
  return { props, panel, document, requests, navigations }
}

test('登録一覧だけの変更は本文を再解析せず、ルール切替は見出しだけを更新する', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = panelHarness(t)
  t.mock.timers.tick(200); await settle()
  assert.equal(h.panel.headings.value.length, 2); assert.equal(h.requests.length, 1)
  h.props.preferences = presets.applyOutlineAction(h.props.preferences, { type: 'save', id: 'saved', name: '見出し設定' })
  await settle(); t.mock.timers.tick(200); await settle()
  h.props.preferences = presets.applyOutlineAction(h.props.preferences, { type: 'rename', id: 'saved', name: '変更した名前' })
  await settle(); t.mock.timers.tick(200); await settle()
  h.props.preferences = presets.applyOutlineAction(h.props.preferences, { type: 'import', preset: { id: 'empty', name: '見出しなし', rules: [] } })
  await settle(); t.mock.timers.tick(200); await settle()
  assert.equal(h.requests.length, 1)
  h.props.preferences = presets.applyOutlineAction(h.props.preferences, { type: 'switch', id: 'empty' })
  await settle(); t.mock.timers.tick(200); await settle()
  assert.equal(h.requests.length, 2); assert.deepEqual(h.panel.headings.value, [])
  assert.deepEqual(h.document, { text: outline.outlineExample, revision: 1 }); assert.deepEqual(h.navigations, [])
  assert.ok(h.requests.every(({ request }) => Object.keys(request.preferences).join(',') === 'rules'))
})

test('ルール切替後に届く本文の旧解析は中止し、空設定の見出しを戻さない', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const old = deferred(), h = panelHarness(t, async request => request.preferences.rules.length ? old.promise : [])
  t.mock.timers.tick(200); await settle()
  h.props.preferences = presets.applyOutlineAction(h.props.preferences, { type: 'rules', rules: [] })
  await settle(); assert.equal(h.requests[0].signal.aborted, true)
  t.mock.timers.tick(200); await settle()
  old.release(outline.extractOutline(h.document.text, outline.createDefaultOutline())); await settle()
  assert.deepEqual(h.panel.headings.value, []); assert.equal(h.panel.stale.value, false); assert.equal(h.panel.pending.value, false)
})
