/** ツリーの開閉と保存、幅操作との競合、フォーカスの保全を検証する。 */
import { assert, loadSourceModule, projectRoot, readFileSync, require, resolve, test } from './test-support.mjs'

/** 実際のレイアウト処理へ、メモリ上の保存先とテスト用の画面を接続する。 */
function createLayoutHarness(t, collapsed = false) {
  const { ref } = require('vue')
  const previousWindow = globalThis.window
  globalThis.window = { innerWidth: 1200, addEventListener() {}, removeEventListener() {} }
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  })
  const saved = []
  const notices = []
  let fail = false
  const module = loadSourceModule('src/useSidebarPaneLayout.ts', {
    './appPreferences': { saveSidebarPreferences: async (value, detached) => {
      if (fail) throw new Error('保存失敗')
      saved.push({ ...value, detached })
    } },
  })
  const detached = ref(false)
  const layout = module.useSidebarPaneLayout({
    initialPreferences: { ui: { sidebar: { width: 350, activePanel: 'project', collapsed }, projectTree: { detached: false } } },
    detached,
    showPersistenceNotice: (text) => notices.push(text),
  })
  t.after(() => layout.dispose())
  return { layout, detached, saved, notices, failSave: () => { fail = true } }
}

/** 捕捉状態を持つ境界からポインターイベントを作り、解放の重複も検出する。 */
function createPointer(clientX, pointerId = 1) {
  const captured = new Set()
  return {
    button: 0, pointerId, clientX, preventDefault() {},
    currentTarget: {
      setPointerCapture: (id) => captured.add(id),
      hasPointerCapture: (id) => captured.has(id),
      releasePointerCapture: (id) => { assert.equal(captured.delete(id), true) },
    },
  }
}

test('閉じた状態から各パネルを直接選べ、幅と最終パネルを一度だけ保存する', async t => {
  const { layout, saved, detached } = createLayoutHarness(t, true)
  detached.value = true
  for (const panel of ['search', 'history', 'outline', 'project']) {
    layout.selectPanel(panel, false)
    assert.equal(layout.sidebarCollapsed.value, false)
    assert.equal(layout.sidebarDrawerWidth.value, 350)
    assert.equal(layout.activePanel.value, panel)
    layout.selectPanel(panel)
    assert.equal(layout.sidebarDrawerWidth.value, 36)
  }
  layout.selectPanel('outline', false)
  await layout.flush()
  assert.deepEqual(saved, [{ width: 350, activePanel: 'outline', collapsed: false, detached: true }])
})

test('128pxを往復するプレビューは未保存で、閉じた後も開始前の幅を復元できる', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { layout, saved } = createLayoutHarness(t)
  const pointer = createPointer(350)
  layout.startSidebarResize(pointer)
  for (const [clientX, width] of [[127, 36], [128, 220], [450, 450], [126, 36]]) {
    layout.moveSidebarResize({ ...pointer, clientX })
    assert.equal(layout.sidebarDrawerWidth.value, width)
    assert.equal(layout.sidebarCollapsed.value, false)
    assert.equal(layout.sidebarDisplayWidth.value, 350)
  }
  t.mock.timers.tick(1000)
  await Promise.resolve()
  assert.deepEqual(saved, [])
  layout.endSidebarResize({ ...pointer, clientX: 100 })
  layout.endSidebarResize({ ...pointer, clientX: 400 })
  layout.cancelSidebarResize(pointer)
  assert.equal(layout.sidebarCollapsed.value, true)
  assert.equal(pointer.currentTarget.hasPointerCapture(1), false)
  await layout.flush()
  assert.deepEqual(saved, [{ width: 350, collapsed: true, detached: false, activePanel: 'project' }])
  layout.toggleSidebarCollapsed()
  assert.equal(layout.sidebarDrawerWidth.value, 350)
})

test('閉じた境界からドラッグで開き、最後のmoveではなく離した位置で幅を確定する', async (t) => {
  const { layout, saved } = createLayoutHarness(t, true)
  const pointer = createPointer(36)
  layout.startSidebarResize(pointer)
  layout.moveSidebarResize({ ...pointer, clientX: 127 })
  assert.equal(layout.sidebarDrawerWidth.value, 36)
  layout.moveSidebarResize({ ...pointer, clientX: 128 })
  assert.equal(layout.sidebarDrawerWidth.value, 220)
  assert.equal(layout.sidebarCollapsed.value, true)
  layout.endSidebarResize({ ...pointer, clientX: 310 })
  await layout.flush()
  assert.deepEqual(saved, [{ width: 310, collapsed: false, detached: false, activePanel: 'project' }])
  layout.startSidebarResize(createPointer(310))
  layout.endSidebarResize(createPointer(900))
  assert.equal(layout.sidebarDrawerWidth.value, 480)
})

test('別ポインターの開始・移動・終了では進行中のドラッグを変更しない', async (t) => {
  const { layout, saved } = createLayoutHarness(t)
  const pointer = createPointer(350)
  const other = createPointer(200, 2)
  layout.startSidebarResize(pointer)
  layout.startSidebarResize(other)
  layout.moveSidebarResize(other)
  layout.endSidebarResize(other)
  layout.cancelSidebarResize(other)
  assert.equal(layout.sidebarResizing.value, true)
  assert.equal(other.currentTarget.hasPointerCapture(2), false)
  assert.equal(layout.sidebarDrawerWidth.value, 350)
  layout.endSidebarResize({ ...pointer, clientX: 380 })
  await layout.flush()
  assert.deepEqual(saved, [{ width: 380, collapsed: false, detached: false, activePanel: 'project' }])
})

for (const collapsed of [false, true]) {
  test(`ドラッグのキャンセルと捕捉喪失は開始時の${collapsed ? '閉じた' : '開いた'}状態へ戻す`, async (t) => {
    const { layout, saved } = createLayoutHarness(t, collapsed)
    for (const type of ['pointercancel', 'lostpointercapture']) {
      const pointer = createPointer(collapsed ? 36 : 350)
      layout.startSidebarResize(pointer)
      layout.moveSidebarResize({ ...pointer, clientX: collapsed ? 400 : 100 })
      layout.cancelSidebarResize({ ...pointer, type })
      layout.endSidebarResize({ ...pointer, clientX: 300 })
      assert.equal(layout.sidebarDrawerWidth.value, collapsed ? 36 : 350)
      assert.equal(layout.sidebarCollapsed.value, collapsed)
    }
    await layout.flush()
    assert.deepEqual(saved, [])
  })
}

test('ドラッグ中は保留保存を遅らせ、キャンセル時にも開始前の確定済み変更を失わない', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { layout, saved } = createLayoutHarness(t)
  layout.onSidebarResizeKeydown({ key: 'ArrowRight', preventDefault() {} })
  const pointer = createPointer(366)
  layout.startSidebarResize(pointer)
  layout.moveSidebarResize({ ...pointer, clientX: 100 })
  t.mock.timers.tick(1000)
  await Promise.resolve()
  assert.deepEqual(saved, [])
  layout.cancelSidebarResize(pointer)
  t.mock.timers.tick(249)
  await Promise.resolve()
  assert.deepEqual(saved, [])
  t.mock.timers.tick(1)
  await layout.flush()
  assert.deepEqual(saved, [{ width: 366, collapsed: false, detached: false, activePanel: 'project' }])
})

test('分離・終了待ち・破棄はドラッグのプレビューを取り消し、確定状態だけ保存する', async (t) => {
  const { layout, saved, detached } = createLayoutHarness(t)
  for (const action of ['detach', 'flush', 'dispose']) {
    layout.onSidebarResizeKeydown({ key: 'End', preventDefault() {} })
    const pointer = createPointer(480)
    layout.startSidebarResize(pointer)
    layout.moveSidebarResize({ ...pointer, clientX: 100 })
    if (action === 'detach') detached.value = true
    else await layout[action]()
    assert.equal(layout.sidebarResizing.value, false)
    assert.equal(layout.sidebarCollapsed.value, false)
    assert.equal(layout.sidebarDrawerWidth.value, 480)
    detached.value = false
  }
  assert.ok(saved.length > 0)
  assert.ok(saved.every((value) => !value.collapsed && value.width === 480))
})

test('ツリーの連続開閉は250msでまとめて保存し、閉じても展開時の幅を失わない', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { layout, saved } = createLayoutHarness(t)
  layout.toggleSidebarCollapsed()
  assert.equal(layout.sidebarDrawerWidth.value, 36)
  assert.equal(layout.sidebarDisplayWidth.value, 350)
  t.mock.timers.tick(200)
  layout.toggleSidebarCollapsed()
  assert.equal(layout.sidebarDrawerWidth.value, 350)
  layout.toggleSidebarCollapsed()
  t.mock.timers.tick(249)
  await Promise.resolve()
  assert.deepEqual(saved, [])
  t.mock.timers.tick(1)
  await layout.flush()
  assert.deepEqual(saved, [{ width: 350, detached: false, collapsed: true, activePanel: 'project' }])
})

test('閉じたツリーはキーで幅変更せず、ドラッグ中のクリックを拒否し、分離中も共通サイドバーを使える', async (t) => {
  const { layout, detached, saved } = createLayoutHarness(t, true)
  const pointer = createPointer(300)
  layout.onSidebarResizeKeydown({ key: 'End', preventDefault() {} })
  assert.equal(layout.sidebarResizing.value, false)
  assert.equal(layout.sidebarDisplayWidth.value, 350)
  layout.toggleSidebarCollapsed()
  layout.startSidebarResize(pointer)
  layout.toggleSidebarCollapsed()
  assert.equal(layout.sidebarCollapsed.value, false)
  layout.moveSidebarResize({ pointerId: 1, clientX: 330 })
  layout.endSidebarResize({ ...pointer, clientX: 330 })
  detached.value = true
  layout.toggleSidebarCollapsed()
  assert.equal(layout.sidebarCollapsed.value, true)
  detached.value = false
  await layout.flush()
  assert.deepEqual(saved, [{ width: 380, detached: false, collapsed: true, activePanel: 'project' }])
  layout.toggleSidebarCollapsed()
  assert.equal(layout.sidebarDrawerWidth.value, 380)
})

test('終了前に開閉の保留保存を完了し、破棄後の操作を拒否する', async (t) => {
  const { layout, saved } = createLayoutHarness(t)
  layout.toggleSidebarCollapsed()
  await layout.dispose()
  assert.deepEqual(saved, [{ width: 350, detached: false, collapsed: true, activePanel: 'project' }])
  layout.toggleSidebarCollapsed()
  assert.equal(layout.sidebarCollapsed.value, true)
})

test('開閉の保存失敗を通知し、現在の表示は保持する', async (t) => {
  const failing = createLayoutHarness(t)
  failing.failSave()
  const pointer = createPointer(350)
  failing.layout.startSidebarResize(pointer)
  failing.layout.endSidebarResize({ ...pointer, clientX: 100 })
  await failing.layout.flush()
  assert.match(failing.notices[0], /表示設定を保存できません.*保存失敗/)
  assert.equal(failing.layout.sidebarCollapsed.value, true)
})

test('境界を動かさず離した場合は展開幅を変えず、不要な保存をしない', async (t) => {
  const { layout, saved } = createLayoutHarness(t, true)
  const pointer = createPointer(36)
  layout.startSidebarResize(pointer)
  layout.endSidebarResize(pointer)
  await layout.flush()
  assert.equal(layout.sidebarDisplayWidth.value, 350)
  assert.equal(layout.sidebarCollapsed.value, true)
  assert.deepEqual(saved, [])
})

test('旧設定の開閉値を補完し、保存した閉じた状態を次回起動へ引き継ぐ', async () => {
  let stored = { schemaVersion: 1, ui: { projectTree: { width: 350, detached: false } } }
  const store = { async get() { return stored }, async set(_key, value) { stored = globalThis.structuredClone(value) }, async save() {}, async reload() {} }
  const mocks = {
    './storageLocation': { getStorageFilePath: () => 'preferences.json' },
    '@tauri-apps/plugin-store': { load: async () => store },
    '@tauri-apps/plugin-fs': { exists: async () => true },
  }
  const preferences = loadSourceModule('src/appPreferences.ts', mocks)
  const initial = await preferences.initializeApplicationPreferences()
  assert.equal(initial.preferences.ui.projectTree.collapsed, false)
  await preferences.saveProjectTreePreferences({ width: 350, detached: false, collapsed: true, activePanel: 'project' })
  const restarted = loadSourceModule('src/appPreferences.ts', mocks)
  assert.deepEqual((await restarted.initializeApplicationPreferences()).preferences.ui.projectTree, {
    width: 350, detached: false, collapsed: true,
  })
  const schema = loadSourceModule('src/appPreferenceSchema.ts')
  assert.equal(schema.normalizeApplicationPreferences({ ui: { projectTree: { collapsed: 'true' } } }).ui.projectTree.collapsed, false)
})

test('隠れるパネルのフォーカスは共通シェルで戻し、分離中も切替領域を残す', () => {
  const shell = readFileSync(resolve(projectRoot, 'src/SidebarShell.vue'), 'utf8')
  assert.match(shell, /content.value\?\.contains\(document.activeElement\)/)
  assert.match(shell, /focusButton\(props.activePanel\)/)
  assert.match(shell, /:inert="collapsed"/)
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  assert.doesNotMatch(app.match(/<VNavigationDrawer[\s\S]*?>/)[0], /v-if/)
})
