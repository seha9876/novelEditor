/** 配色の対象表示の対応漏れ、解除、通信順序、表示範囲を検証する。 */
import { assert, deferred, loadSourceModule, test } from './test-support.mjs'
const appearance = loadSourceModule('src/appearance.ts')
const targets = loadSourceModule('src/appearanceTargets.ts')

test('全配色キーに説明と適用色の一致する見本があり、保存形式には追加されない', () => {
  assert.deepEqual(Object.keys(targets.colorTargets), appearance.colorKeys)
  for (const key of appearance.colorKeys) {
    const definition = targets.colorTargets[key]
    assert.ok(definition.description.length > 0)
    assert.ok(definition.selectors.length > 0)
    const parts = targets.getColorPreviewParts(key)
    assert.ok(parts.length <= 3)
    const sample = parts.find(part => part.id === definition.sample)
    assert.ok(sample, key)
    assert.ok([sample.background, sample.text, sample.border].includes(key), `${key}の見本がその配色キーを使う`)
  }
  const serialized = JSON.parse(appearance.exportColorPreset(appearance.builtInPresets[0]))
  assert.deepEqual(Object.keys(serialized).sort(), ['colors', 'format', 'name', 'version'])
})

test('入力中の行を優先し、古い離脱と重複通知を無視して一時状態だけを解除する', () => {
  const calls = []
  const preferences = appearance.createDefaultAppearance()
  const before = JSON.stringify(preferences)
  const interaction = targets.createColorTargetInteraction(key => calls.push(key))
  interaction.hover('editorText', true)
  interaction.focus('editorText', true)
  interaction.hover('toolbarText', true)
  interaction.hover('editorText', false)
  assert.deepEqual(calls, ['editorText'])
  interaction.focus('editorText', false)
  assert.deepEqual(calls, ['editorText', 'toolbarText'])
  interaction.clear()
  interaction.clear()
  interaction.focus('editorText', false)
  assert.deepEqual(calls, ['editorText', 'toolbarText', null])
  assert.equal(JSON.stringify(preferences), before)
})

/** 各窓の購読を独立して保持し、Tauri配送だけを置き換える。 */
function eventBus() {
  const handlers = new Map()
  const sent = []
  /** 登録された複数の窓へ同じイベントを配送する。 */
  async function deliver(name, payload) {
    sent.push({ name, payload })
    for (const callback of handlers.get(name) ?? []) callback({ payload })
  }
  const api = {
    /** Tauriの購読解除を検証できるよう、窓ごとのコールバックを登録する。 */
    async listen(name, callback) {
      const listeners = handlers.get(name) ?? new Set()
      handlers.set(name, listeners); listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
    emit: deliver,
    emitTo: async (_window, name, payload) => deliver(name, payload),
  }
  return { api, deliver, sent, subscriptionCount: () => [...handlers.values()].reduce((count, set) => count + set.size, 0) }
}

test('設定窓の世代と入力順を検証し、閉じた窓の通知で強調を復活させない', async () => {
  const bus = eventBus()
  const channel = loadSourceModule('src/appearanceTargetChannel.ts', { '@tauri-apps/api/event': bus.api })
  const main = [], child = []
  const host = channel.createAppearanceTargetHost(key => main.push(key))
  const client = channel.createAppearanceTargetClient(key => child.push(key))
  await host.setup(); await client.setup()
  host.setSession('first')
  await bus.deliver(channel.APPEARANCE_TARGET_COMMAND, { session: 'first', sequence: 2, key: 'editorText' })
  await bus.deliver(channel.APPEARANCE_TARGET_COMMAND, { session: 'first', sequence: 1, key: 'toolbarText' })
  await bus.deliver(channel.APPEARANCE_TARGET_COMMAND, { session: 'first', sequence: 3, key: 'invalid' })
  assert.deepEqual(main, ['editorText'])
  host.setSession(null)
  await bus.deliver(channel.APPEARANCE_TARGET_COMMAND, { session: 'first', sequence: 4, key: 'editorText' })
  assert.deepEqual(main, ['editorText', null])
  host.setSession('second')
  await bus.deliver(channel.APPEARANCE_TARGET_COMMAND, { session: 'second', sequence: 1, key: 'treeText' })
  await bus.deliver(channel.APPEARANCE_TARGET_STATE, { revision: 1, key: 'editorText' })
  assert.equal(child.at(-1), 'treeText')
  const late = []
  const lateClient = channel.createAppearanceTargetClient(key => late.push(key))
  await lateClient.setup()
  assert.equal(late.at(-1), 'treeText')
  client.dispose(); lateClient.dispose(); host.dispose()
  assert.equal(bus.subscriptionCount(), 0)
  assert.equal(main.at(-1), null)
  assert.ok(bus.sent.every(event => !event.name.includes('settings-command') && !event.name.includes('appearance-state')))
})

test('通信待ちの中間対象を捨て、最終解除を最後に送る', async () => {
  const pending = deferred(), sent = []
  const channel = loadSourceModule('src/appearanceTargetChannel.ts', { '@tauri-apps/api/event': {
    emitTo: async (_window, _name, payload) => { sent.push(payload); if (sent.length === 1) await pending.promise },
  } })
  const sender = channel.createAppearanceTargetSender('session')
  sender.update('editorText')
  sender.update('toolbarText')
  sender.dispose()
  sender.update('treeText')
  pending.release()
  await sender.flush()
  assert.deepEqual(sent.map(message => message.key), ['editorText', null])
  assert.deepEqual(sent.map(message => message.sequence), [1, 3])
})

test('購読開始中の画面破棄でも遅れて成立した購読を解除する', async () => {
  const pending = deferred()
  let removed = 0
  const channel = loadSourceModule('src/appearanceTargetChannel.ts', { '@tauri-apps/api/event': {
    listen: async () => { await pending.promise; return () => { removed++ } },
  } })
  const client = channel.createAppearanceTargetClient(() => {})
  const setup = client.setup()
  client.dispose(); pending.release(); await setup
  assert.equal(removed, 1)
})

test('強調枠は画面とスクロール領域で切り取り、隠れた対象を除外する', t => {
  const previousWindow = globalThis.window, previousStyle = globalThis.getComputedStyle
  globalThis.window = { innerWidth: 800, innerHeight: 600 }
  globalThis.getComputedStyle = element => ({ display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible', ...element.style })
  t.after(() => {
    if (previousWindow) globalThis.window = previousWindow; else delete globalThis.window
    if (previousStyle) globalThis.getComputedStyle = previousStyle; else delete globalThis.getComputedStyle
  })
  const { getVisibleTargetRectangle } = loadSourceModule('src/appearanceTargetOverlay.ts')
  const parent = { style: { overflowY: 'auto' }, parentElement: null, getBoundingClientRect: () => ({ left: 10, top: 100, right: 300, bottom: 250 }) }
  const element = { style: {}, parentElement: parent, closest: () => null, getBoundingClientRect: () => ({ left: -20, top: 80, right: 900, bottom: 300 }) }
  assert.deepEqual(getVisibleTargetRectangle(element), { left: 0, top: 100, width: 800, height: 150 })
  parent.style.display = 'none'
  assert.equal(getVisibleTargetRectangle(element), null)
  parent.style.display = 'block'; element.closest = () => ({})
  assert.equal(getVisibleTargetRectangle(element), null)
})

test('強調装飾だけを更新し、解除時に監視と描画予約を残さない', t => {
  const globals = ['window', 'document', 'Element', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']
  const previous = new Map(globals.map(name => [name, globalThis[name]]))
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value
    }
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.requestAnimationFrame = undefined
  globalThis.cancelAnimationFrame = undefined
  const events = new Map(), observers = []
  let renders = 0
  /** 元の本文には触れず、装飾層への操作だけを記録する最小のDOM代替。 */
  class TargetElement {
    style = {}
    parentElement = null
    children = []
    textContent = '原稿の本文'
    /** 強調対象は画面内の本文領域として固定する。 */
    getBoundingClientRect() { return { left: 100, top: 80, right: 700, bottom: 400 } }
    /** 見本や設定行以外の対象を返す。 */
    closest() { return null }
    /** 装飾層にだけ要素を追加する。 */
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child) } }
    /** 再描画の回数を記録し、フレーム集約を検証する。 */
    replaceChildren(fragment) { renders++; this.children = fragment.children }
    /** 装飾層の撤去を検証できるよう親の一覧から削除する。 */
    remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this) }
    /** アクセシビリティ属性は装飾層にだけ設定する。 */
    setAttribute() {}
  }
  /** 解除後にすべての監視が切れることを記録する。 */
  class TargetObserver {
    active = false
    /** 手動でレイアウト変化を通知できるようコールバックを保持する。 */
    constructor(callback) { this.callback = callback; observers.push(this) }
    /** DOM・サイズの監視開始を記録する。 */
    observe() { this.active = true }
    /** DOM・サイズの監視解除を記録する。 */
    disconnect() { this.active = false }
  }
  const editor = new TargetElement(), body = new TargetElement()
  const before = JSON.stringify(editor)
  globalThis.Element = TargetElement
  globalThis.MutationObserver = globalThis.ResizeObserver = TargetObserver
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' })
  globalThis.window = {
    innerWidth: 800, innerHeight: 600,
    addEventListener: (name, callback) => events.set(name, callback),
    removeEventListener: name => events.delete(name),
  }
  globalThis.document = {
    body, documentElement: body,
    querySelectorAll: () => [editor],
    createElement: () => new TargetElement(),
    createDocumentFragment: () => new TargetElement(),
  }
  const { createAppearanceTargetOverlay } = loadSourceModule('src/appearanceTargetOverlay.ts')
  const overlay = createAppearanceTargetOverlay()
  overlay.update('editorText')
  assert.equal(body.children.length, 1)
  assert.equal(body.children[0].children[0].children.at(-1).textContent, '本文 · 文字（文字）')
  events.get('scroll')(); events.get('resize')(); events.get('scroll')()
  t.mock.timers.tick(16)
  assert.equal(renders, 2)
  events.get('scroll')()
  overlay.update(null)
  t.mock.timers.tick(16)
  assert.equal(renders, 2)
  assert.equal(body.children.length, 0)
  assert.equal(events.size, 0)
  assert.ok(observers.every(observer => !observer.active))
  assert.equal(JSON.stringify(editor), before)
  overlay.dispose(); overlay.update('editorText')
  assert.equal(body.children.length, 0)
})
