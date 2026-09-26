/** プロジェクトツリーの純粋な操作判定、Tauri更新、分離表示を検証する。 */
import {
  assert,
  deferred,
  loadSourceModule,
  readFileSync,
  projectRoot,
  require,
  resolve,
  test,
  ts,
} from './test-support.mjs'

test('分離ツリーControllerは購読待ちの破棄後に遅着unlistenを解除する', async () => {
  const listenDeferred = deferred()
  let unlistenCount = 0
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const { ref } = require('vue')
    const controllerModule = loadSourceModule('src/useProjectTreeWindowController.ts', {
      './appPreferences': { saveProjectTreePreferences: async () => {} },
      '@tauri-apps/api/event': {
        async emitTo() {},
        async listen() { return listenDeferred.promise },
      },
      '@tauri-apps/api/webviewWindow': {
        WebviewWindow: class {},
      },
    })
    const controller = controllerModule.useProjectTreeWindowController({
      initialPreferences: { ui: { projectTree: { width: 280, detached: false } } },
      busy: ref(false),
      documentLocked: ref(false),
      documentOrigin: ref(null),
      mainCloseInProgress: ref(false),
      showPersistenceNotice: () => {},
      showError: async () => {},
      openProjectTreeFile: async () => {},
      onOriginDetached: () => {},
    })

    const setup = controller.setup()
    await controller.dispose()
    listenDeferred.release(() => { unlistenCount += 1 })
    await setup
    assert.equal(unlistenCount, 1)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('分離ツリー生成の破棄後イベントは状態保存や通知を行わず失敗で完了する', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const { ref } = require('vue')
    const callbacks = {}
    let destroyCount = 0
    const notices = []
    const savedPreferences = []
    class MockWebviewWindow {
      constructor() {}
      once(event, callback) {
        callbacks[event] = callback
        return Promise.resolve(() => {})
      }
      destroy() {
        destroyCount += 1
        return Promise.resolve()
      }
    }
    const controllerModule = loadSourceModule('src/useProjectTreeWindowController.ts', {
      './appPreferences': {
        saveProjectTreePreferences: async (preferences) => { savedPreferences.push(preferences) },
      },
      '@tauri-apps/api/event': {
        async emitTo() {},
        async listen() { return () => {} },
      },
      '@tauri-apps/api/webviewWindow': { WebviewWindow: MockWebviewWindow },
    })
    const controller = controllerModule.useProjectTreeWindowController({
      initialPreferences: { ui: { projectTree: { width: 280, detached: false } } },
      busy: ref(false),
      documentLocked: ref(false),
      documentOrigin: ref(null),
      mainCloseInProgress: ref(false),
      showPersistenceNotice: (notice) => { notices.push(notice) },
      showError: async () => {},
      openProjectTreeFile: async () => {},
      onOriginDetached: () => {},
    })

    const opening = controller.openProjectTreeWindow()
    await controller.dispose()
    callbacks['tauri://created']()
    assert.equal(await opening, false)
    assert.equal(destroyCount, 1)
    assert.deepEqual(notices, [])
    assert.deepEqual(savedPreferences, [])
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

/** 分離ツリーの生成・破棄イベントを手動で進め、実際のController lifecycleを検証する。 */
function createProjectTreeWindowHarness(destroyImplementation = () => Promise.resolve()) {
  const { ref } = require('vue')
  const callbacks = {}
  const emittedStates = []
  const notices = []
  const savedPreferences = []
  let commandHandler
  let constructorCount = 0
  let destroyCount = 0
  class MockWebviewWindow {
    constructor() {
      constructorCount += 1
    }
    once(event, callback) {
      callbacks[event] = callback
      return Promise.resolve(() => {})
    }
    destroy() {
      destroyCount += 1
      return destroyImplementation()
    }
  }
  const controllerModule = loadSourceModule('src/useProjectTreeWindowController.ts', {
    './appPreferences': {
      saveProjectTreePreferences: async (preferences) => { savedPreferences.push(preferences) },
    },
    '@tauri-apps/api/event': {
      async emitTo(_label, _event, state) { emittedStates.push(state) },
      async listen(_event, handler) { commandHandler = handler; return () => {} },
    },
    '@tauri-apps/api/webviewWindow': { WebviewWindow: MockWebviewWindow },
  }, new Map())
  const controller = controllerModule.useProjectTreeWindowController({
    initialPreferences: { ui: { projectTree: { width: 280, detached: false } } },
    busy: ref(false),
    documentLocked: ref(false),
    documentOrigin: ref(null),
    mainCloseInProgress: ref(false),
    showPersistenceNotice: (notice) => { notices.push(notice) },
    showError: async () => {},
    openProjectTreeFile: async () => {},
    onOriginDetached: () => {},
  })
  return {
    controller,
    callbacks,
    emittedStates,
    notices,
    savedPreferences,
    get commandHandler() { return commandHandler },
    get constructorCount() { return constructorCount },
    get destroyCount() { return destroyCount },
  }
}

test('分離ツリーはcreated/errorなしのdestroyedだけでも生成Promiseを失敗で完了する', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const harness = createProjectTreeWindowHarness()
    const opening = harness.controller.openProjectTreeWindow()
    harness.callbacks['tauri://destroyed']()
    assert.equal(await opening, false)
    assert.equal(harness.destroyCount, 0)
    assert.deepEqual(harness.notices, [])
    await harness.controller.dispose()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('分離ツリーのerror後にdestroyedが遅着しても生成Promiseを一度だけ失敗で完了する', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const harness = createProjectTreeWindowHarness()
    const opening = harness.controller.openProjectTreeWindow()
    harness.callbacks['tauri://error']({ payload: '生成失敗' })
    harness.callbacks['tauri://destroyed']()
    assert.equal(await opening, false)
    assert.equal(harness.destroyCount, 0)
    assert.equal(harness.notices.length, 1)
    await harness.controller.dispose()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('分離ツリーのdockとdisposeが競合してもdestroyを一度だけ共有する', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const destroyDeferred = deferred()
    const harness = createProjectTreeWindowHarness(() => destroyDeferred.promise)
    await harness.controller.setup()
    const opening = harness.controller.openProjectTreeWindow()
    harness.callbacks['tauri://created']()
    assert.equal(await opening, true)
    const windowId = harness.emittedStates.at(-1).windowId
    harness.commandHandler({ payload: { type: 'dock', windowId } })
    await Promise.resolve()
    const disposing = harness.controller.dispose()
    destroyDeferred.release()
    await disposing
    await Promise.resolve()
    assert.equal(harness.destroyCount, 1)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('分離ツリーのclose待ち中にdisposeしても破棄後の再生成を行わない', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const destroyDeferred = deferred()
    const harness = createProjectTreeWindowHarness(() => destroyDeferred.promise)
    await harness.controller.setup()
    const opening = harness.controller.openProjectTreeWindow()
    harness.callbacks['tauri://created']()
    assert.equal(await opening, true)
    const windowId = harness.emittedStates.at(-1).windowId
    harness.commandHandler({ payload: { type: 'dock', windowId } })
    await Promise.resolve()
    const reopening = harness.controller.openProjectTreeWindow()
    const disposing = harness.controller.dispose()
    destroyDeferred.release()
    assert.equal(await reopening, false)
    await disposing
    await Promise.resolve()
    assert.equal(harness.constructorCount, 1)
    assert.equal(harness.destroyCount, 1)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('分離ツリーの終了用closeとdisposeが競合してもdestroyを一度だけ共有する', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const destroyDeferred = deferred()
    const harness = createProjectTreeWindowHarness(() => destroyDeferred.promise)
    const opening = harness.controller.openProjectTreeWindow()
    harness.callbacks['tauri://created']()
    assert.equal(await opening, true)
    const closing = harness.controller.closeProjectTreeWindowForExit()
    const disposing = harness.controller.dispose()
    destroyDeferred.release()
    await Promise.all([closing, disposing])
    assert.equal(harness.destroyCount, 1)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('ツリー内のポインター位置は既存の前後・フォルダ内配置を保つ', () => {
  const tree = loadSourceModule('src/projectTreeModel.ts')
  assert.equal(tree.projectTreeRowPlacement('folder', 5, 0, 40), 'before')
  assert.equal(tree.projectTreeRowPlacement('folder', 20, 0, 40), 'inside')
  assert.equal(tree.projectTreeRowPlacement('folder', 35, 0, 40), 'after')
  assert.equal(tree.projectTreeRowPlacement('file', 20, 0, 40), 'after')
  assert.equal(tree.projectTreeRowPlacement('file', 0, 0, 0), 'before')
})

test('ツリー外や境界の許容範囲外では自動スクロールせず、上下端だけ移動量を返す', () => {
  const tree = loadSourceModule('src/projectTreeModel.ts')
  const bounds = { left: 100, right: 300, top: 50, bottom: 350 }
  assert.equal(tree.projectTreeAutoScrollStep({ x: 301, y: 349 }, bounds), 0)
  assert.equal(tree.projectTreeAutoScrollStep({ x: 99, y: 51 }, bounds), 0)
  assert.equal(tree.projectTreeAutoScrollStep({ x: 200, y: 9 }, bounds), 0)
  assert.equal(tree.projectTreeAutoScrollStep({ x: 200, y: 391 }, bounds), 0)
  assert.equal(tree.projectTreeAutoScrollStep({ x: 200, y: 70 }, bounds), -10)
  assert.equal(tree.projectTreeAutoScrollStep({ x: 200, y: 330 }, bounds), 10)
  assert.equal(tree.projectTreeAutoScrollStep({ x: 200, y: 10 }, bounds), -18)
})

test('ネイティブドロップの座標・領域・追加先とポインター操作の区別を保つ', () => {
  const tree = loadSourceModule('src/projectTreeModel.ts')
  assert.deepEqual(tree.projectTreePhysicalToViewport({ x: 800, y: 500 }, 2), { x: 400, y: 250 })
  assert.deepEqual(tree.projectTreeExternalDropDestination(false, null), { accepted: false, parentId: null })
  assert.deepEqual(tree.projectTreeExternalDropDestination(true, null), { accepted: true, parentId: null })
  assert.deepEqual(tree.projectTreeExternalDropDestination(true, { id: 9, kind: 'file' }), { accepted: true, parentId: null })
  assert.deepEqual(tree.projectTreeExternalDropDestination(true, { id: 12, kind: 'folder' }), { accepted: true, parentId: 12 })
  assert.equal(tree.hasProjectTreePointerDragStarted({ x: 10, y: 10 }, { x: 13, y: 13 }), false)
  assert.equal(tree.hasProjectTreePointerDragStarted({ x: 10, y: 10 }, { x: 13, y: 14 }), true)
  assert.equal(tree.shouldSuppressProjectTreeClick(true, 1), true)
  assert.equal(tree.shouldSuppressProjectTreeClick(true, 0), false)
  assert.equal(tree.shouldSuppressProjectTreeClick(false, 1), false)
})

test('ツリーの通常・修飾クリックと右クリックで可視行の選択を更新する', () => {
  const tree = loadSourceModule('src/projectTreeModel.ts')
  const rows = [1, 2, 3, 4, 5]
  assert.deepEqual(tree.projectTreeSelectionAfterClick(rows, new Set(), null, 2, {
    ctrlKey: false, shiftKey: false,
  }), { selectedNodeIds: [2], anchorNodeId: 2 })
  assert.deepEqual(tree.projectTreeSelectionAfterClick(rows, new Set([2]), 2, 4, {
    ctrlKey: false, shiftKey: true,
  }), { selectedNodeIds: [2, 3, 4], anchorNodeId: 2 })
  assert.deepEqual(tree.projectTreeSelectionAfterClick(rows, new Set([2, 4]), 4, 3, {
    ctrlKey: true, shiftKey: true,
  }), { selectedNodeIds: [2, 3, 4], anchorNodeId: 4 })
  assert.deepEqual(tree.projectTreeSelectionAfterClick(rows, new Set([2, 3]), 3, 2, {
    ctrlKey: true, shiftKey: false,
  }), { selectedNodeIds: [3], anchorNodeId: 2 })
  assert.deepEqual(tree.projectTreeSelectionAfterContextMenu(rows, new Set([2, 4]), 4), {
    selectedNodeIds: [2, 4], anchorNodeId: 4,
  })
  assert.deepEqual(tree.projectTreeSelectionAfterContextMenu(rows, new Set([2, 4]), 3), {
    selectedNodeIds: [3], anchorNodeId: 3,
  })
})

test('ツリー選択は再読込後に別プロジェクトや不在ノードを除外し、複数削除APIを使う', async () => {
  let invocation
  const mocks = {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      invocation = { command, args }
    } },
  }
  const cache = new Map()
  const tree = loadSourceModule('src/projectTreeModel.ts', mocks, cache)
  const client = loadSourceModule('src/projectTreeClient.ts', mocks, cache)
  assert.deepEqual(tree.projectTreeSelectionForNodes(new Set([1, 2, 9]), [
    { id: 1, projectId: 7 }, { id: 2, projectId: 7 }, { id: 9, projectId: 8 },
  ], 7), [1, 2])
  assert.deepEqual(tree.projectTreeSelectionForNodes(new Set([1]), [
    { id: 1, projectId: 7 },
  ], null), [])
  await client.removeProjectNodes([1, 2])
  assert.deepEqual(invocation, { command: 'project_nodes_remove', args: { nodeIds: [1, 2] } })
})

test('ツリーの複数選択メニューは一括解除だけを表示し、再読込で不可視選択を整理する', () => {
  const sidebar = readFileSync(resolve(projectRoot, 'src/ProjectTreeSidebar.vue'), 'utf8')
  const menu = sidebar.match(/<VList v-if="contextNode"[\s\S]*?<\/VList>/)?.[0]
  assert.ok(menu)
  const multiMenu = menu.slice(menu.indexOf('<template v-if="selectedNodes.length > 1">'), menu.indexOf('<template v-else>'))
  const singleMenu = menu.slice(menu.indexOf('<template v-else>'))
  assert.match(multiMenu, /選択した\$\{selectedNodes\.length\}件の登録を解除/)
  assert.doesNotMatch(multiMenu, /VDivider|title="登録を解除"/)
  assert.match(singleMenu, /VDivider[\s\S]*title="登録を解除"/)
  assert.match(sidebar, /const displayedSelection = validSelection\.filter\(\(id\) => visibleIds\.has\(id\)\)/)
})

test('複数TXTのドロップ登録は一部が失敗しても残りを続行する', async () => {
  const invocations = []
  const tree = loadSourceModule('src/projectTreeClient.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      invocations.push({ command, args })
      if (args.path.endsWith('壊れた.txt')) throw new Error('参照先を確認できません')
    } },
  })
  const result = await tree.registerDroppedProjectFiles(7, 12, [
    'C:\\drafts\\一.txt', 'C:\\drafts\\壊れた.txt', 'C:\\drafts\\二.txt',
  ])
  assert.equal(result.registeredCount, 2)
  assert.deepEqual(result.failures, [{ path: 'C:\\drafts\\壊れた.txt', error: 'Error: 参照先を確認できません' }])
  assert.equal(invocations.length, 3)
  assert.ok(invocations.every(({ command, args }) => command === 'project_file_register'
    && args.projectId === 7 && args.parentId === 12))
})

test('分離ツリーは開く結果を反映してからドックし、復帰時に展開状態を引き継ぐ', () => {
  const detachedWindow = readFileSync(resolve(projectRoot, 'src/ProjectTreeWindow.vue'), 'utf8')
  const sidebar = readFileSync(resolve(projectRoot, 'src/ProjectTreeSidebar.vue'), 'utf8')
  const main = readFileSync(resolve(projectRoot, 'src/useProjectTreeWindowController.ts'), 'utf8')

  assert.match(detachedWindow, /if \(pendingOpenRequestId\) \{[\s\S]*?dockAfterOpenRequest = true/)
  assert.match(detachedWindow, /@open-result-applied="handleOpenResultApplied"/)
  assert.match(detachedWindow, /メイン画面へ接続できないため、ファイルを開けませんでした。/)
  assert.match(detachedWindow, /@unavailable-change="publishUnavailableNodes"/)
  assert.match(sidebar, /new Set<number>\(props\.expandedFolderIds\)/)
  assert.match(sidebar, /\{ deep: true, immediate: true \}/)
  assert.match(sidebar, /new Set<number>\(props\.unavailableNodeIds\)/)
  assert.match(sidebar, /finally \{\s*emit\('open-result-applied', result\.requestId\)/)
  assert.doesNotMatch(sidebar, /if \(result\?\.unavailable\) unavailableNodes\.value/)
  assert.match(sidebar, /if \(result\.error\) \{\s*if \(result\.unavailable\) next\.add\(result\.nodeId\)\s*unavailableNodes\.value = next/)
  assert.match(sidebar, /applyingUnavailableNodeProps = true[\s\S]*?applyingUnavailableNodeProps = false/)
  assert.match(main, /watch\(\s*\[options\.busy, options\.documentLocked, options\.documentOrigin, options\.mainCloseInProgress\]/)
  assert.match(main, /projectTreeOpenResult\.value = null/)
  assert.match(main, /if \(result\.error && result\.unavailable\) unavailable\.add\(result\.nodeId\)\s*else if \(!result\.error\) unavailable\.delete\(result\.nodeId\)/)
  assert.match(main, /ファイル操作の結果を分離ツリーへ伝えられませんでした/)
})

test('ツリー幅ドラッグ中だけ遷移を止め、ポインター中は保存を遅らせる', () => {
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const main = readFileSync(resolve(projectRoot, 'src/useProjectTreeWindowController.ts'), 'utf8')
  const styles = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(app, /:class="\{ 'is-project-tree-resizing': projectTreeResizing \}"/)
  assert.match(main, /setProjectTreeWidth\(projectTreeResizeStart\.startWidth \+ event\.clientX - projectTreeResizeStart\.startX, false\)/)
  assert.match(app, /@lostpointercapture="endProjectTreeResize"/)
  assert.match(main, /projectTreeResizing\.value = false\s*scheduleProjectTreePreferencesSave\(\)/)
  assert.match(main, /if \(persist\) scheduleProjectTreePreferencesSave\(\)/)
  assert.match(styles, /\.app-shell\.is-project-tree-resizing \.project-navigation,[\s\S]*?\.writing-area \{ transition: none; \}/)
})

test('ドラッグ開始時は未実行の幅保存だけを取り消し、終了処理は一度だけ保存する', () => {
  const controller = readFileSync(resolve(projectRoot, 'src/useProjectTreeWindowController.ts'), 'utf8')
  const sourceFile = ts.createSourceFile('useProjectTreeWindowController.ts', controller, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions = new Map()
  const findResizeFunctions = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name
      && ['startProjectTreeResize', 'endProjectTreeResize'].includes(node.name.text)) {
      functions.set(node.name.text, node.getText(sourceFile))
    }
    ts.forEachChild(node, findResizeFunctions)
  }
  findResizeFunctions(sourceFile)
  assert.ok(functions.has('startProjectTreeResize'))
  assert.ok(functions.has('endProjectTreeResize'))

  const harnessSource = `
    let projectTreeSaveTimer = initialTimer
    let projectTreeResizeStart = null
    const projectTreeDisplayWidth = { value: 280 }
    const projectTreeResizing = { value: false }
    const projectTreeSavePromise = activeSavePromise
    let scheduledSaveCount = 0
    function scheduleProjectTreePreferencesSave() { scheduledSaveCount += 1 }
    ${functions.get('startProjectTreeResize')}
    ${functions.get('endProjectTreeResize')}
    return {
      start: (event) => startProjectTreeResize(event),
      end: (event) => endProjectTreeResize(event),
      get timer() { return projectTreeSaveTimer },
      get resizeStart() { return projectTreeResizeStart },
      get isResizing() { return projectTreeResizing.value },
      get scheduledSaveCount() { return scheduledSaveCount },
      savePromise: projectTreeSavePromise,
    }
  `
  const executable = ts.transpileModule(harnessSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const createHarness = new Function('initialTimer', 'activeSavePromise', 'clearTimeout', executable)
  const clearedTimers = []
  const inFlightSavePromise = Promise.resolve('既に開始済み')
  const harness = createHarness(123, inFlightSavePromise, (timer) => clearedTimers.push(timer))
  let capturedPointerId = null
  const event = {
    button: 0,
    pointerId: 7,
    clientX: 300,
    preventDefault() {},
    currentTarget: { setPointerCapture: (pointerId) => { capturedPointerId = pointerId } },
  }

  harness.start(event)
  assert.deepEqual(clearedTimers, [123])
  assert.equal(harness.timer, undefined)
  assert.equal(harness.scheduledSaveCount, 0)
  assert.equal(harness.isResizing, true)
  assert.equal(capturedPointerId, 7)
  assert.equal(harness.savePromise, inFlightSavePromise)

  harness.end(event)
  assert.equal(harness.isResizing, false)
  assert.equal(harness.resizeStart, null)
  assert.equal(harness.scheduledSaveCount, 1)
  harness.end(event)
  assert.equal(harness.scheduledSaveCount, 1)

  const withoutPendingTimer = createHarness(undefined, inFlightSavePromise, (timer) => clearedTimers.push(timer))
  withoutPendingTimer.start(event)
  assert.deepEqual(clearedTimers, [123])
  assert.equal(withoutPendingTimer.savePromise, inFlightSavePromise)
})
