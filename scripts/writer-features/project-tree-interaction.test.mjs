/** プロジェクトツリーのモデル、Store、選択、操作、D&Dを検証する。 */
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

test('選択Composableは展開状態・表示行・選択を実際の状態として同期する', () => {
  const { ref } = require('vue')
  const selectionModule = loadSourceModule('src/useProjectTreeSelection.ts')
  const snapshot = ref({
    projects: [{ id: 1, name: '主プロジェクト' }, { id: 2, name: '別プロジェクト' }],
    nodes: [
      { id: 10, projectId: 1, parentId: null, kind: 'folder', name: '章' },
      { id: 11, projectId: 1, parentId: 10, kind: 'file', name: '一.txt' },
      { id: 12, projectId: 1, parentId: null, kind: 'file', name: '二.txt' },
      { id: 20, projectId: 2, parentId: null, kind: 'file', name: '別.txt' },
    ],
    activeProjectId: 1,
  })
  const expandedChanges = []
  const unavailableChanges = []
  const selection = selectionModule.useProjectTreeSelection({
    snapshot,
    expandedFolderIds: [10],
    unavailableNodeIds: [11],
    onExpandedChange: (ids) => expandedChanges.push(ids),
    onUnavailableChange: (ids) => unavailableChanges.push(ids),
    isDialogOpen: () => false,
    onDeleteSelection: () => {},
    onEscape: () => {},
  })

  assert.deepEqual(selection.visibleRows.value.map(({ node, depth }) => [node.id, depth]), [[10, 0], [11, 1], [12, 0]])
  selection.selectNodeFromClick({ ctrlKey: false, metaKey: false, shiftKey: false }, snapshot.value.nodes[1])
  selection.selectNodeFromClick({ ctrlKey: false, metaKey: false, shiftKey: true }, snapshot.value.nodes[2])
  assert.deepEqual([...selection.selectedNodeIds.value], [11, 12])
  assert.equal(selection.containsNode(10, 11), true)
  assert.equal(selection.containsNode(12, 11), false)

  selection.toggleFolder(10)
  assert.deepEqual(selection.visibleRows.value.map(({ node }) => node.id), [10, 12])
  assert.deepEqual(expandedChanges, [[]])
  selection.setUnavailableNodeIds([12])
  assert.deepEqual([...selection.unavailableNodes.value], [12])
  assert.deepEqual(unavailableChanges, [[12]])

  snapshot.value = {
    ...snapshot.value,
    nodes: snapshot.value.nodes.filter((node) => node.id !== 11),
  }
  selection.handleSnapshotRefreshed(snapshot.value)
  assert.deepEqual([...selection.selectedNodeIds.value], [12])
  assert.deepEqual([...selection.unavailableNodes.value], [12])
})

test('snapshot更新で削除済みの参照切れIDを親へ通知する', () => {
  const { ref } = require('vue')
  const selectionModule = loadSourceModule('src/useProjectTreeSelection.ts')
  const snapshot = ref({
    projects: [{ id: 1, name: '主プロジェクト' }],
    nodes: [
      { id: 11, projectId: 1, parentId: null, kind: 'file', name: '削除予定.txt' },
      { id: 12, projectId: 1, parentId: null, kind: 'file', name: '残る.txt' },
    ],
    activeProjectId: 1,
  })
  const unavailableChanges = []
  const selection = selectionModule.useProjectTreeSelection({
    snapshot,
    expandedFolderIds: [],
    unavailableNodeIds: [11, 12],
    onExpandedChange: () => {},
    onUnavailableChange: (ids) => unavailableChanges.push(ids),
    isDialogOpen: () => false,
    onDeleteSelection: () => {},
    onEscape: () => {},
  })

  snapshot.value = { ...snapshot.value, nodes: [snapshot.value.nodes[1]] }
  selection.handleSnapshotRefreshed(snapshot.value)

  assert.deepEqual([...selection.unavailableNodes.value], [12])
  assert.deepEqual(unavailableChanges, [[12]])
})

test('ツリーActionsの開く結果は既存の参照切れ状態を保ったまま更新する', async () => {
  const { ref } = require('vue')
  const actionsModule = loadSourceModule('src/useProjectTreeActions.ts', {
    '@tauri-apps/plugin-dialog': {
      ask: async () => false,
      message: async () => {},
    },
    './textFile': {
      chooseTextFile: async () => null,
      fileName: (path) => path.split('\\').at(-1),
    },
    './projectTreeClient': {
      createProject: async () => {},
      createProjectFolder: async () => {},
      deleteProject: async () => {},
      registerProjectFile: async () => {},
      registerDroppedProjectFiles: async () => ({ registeredCount: 0, failures: [] }),
      relinkProjectFile: async () => {},
      removeProjectNodes: async () => {},
      renameProject: async () => {},
      renameProjectFolder: async () => {},
      selectProject: async () => {},
    },
  })
  const snapshot = ref({ projects: [], nodes: [], activeProjectId: null })
  const pendingOpenRequest = ref({ requestId: 'request-1', nodeId: 4, projectId: 1 })
  const applied = []
  const errors = []
  let unavailable = [9]
  const actions = actionsModule.useProjectTreeActions({
    snapshot,
    pendingOpenRequest,
    documentOrigin: () => null,
    selectedNodes: () => [],
    unavailableNodeIds: () => unavailable,
    isBusy: () => false,
    runMutation: async () => true,
    showTreeError: async (error) => { errors.push(error) },
    setUnavailableNodeIds: (ids) => { unavailable = ids },
    clearNodeSelection: () => {},
    selectNodeFromContextMenu: () => {},
    expandFolderPath: () => {},
    containsNode: () => false,
    onOpenFile: () => {},
    onOpenResultApplied: (requestId) => { applied.push(requestId) },
    onOriginDetached: () => {},
  })

  await actions.applyOpenResult({ requestId: 'request-1', nodeId: 4, error: '参照先なし', unavailable: true })
  assert.equal(pendingOpenRequest.value, null)
  assert.deepEqual(unavailable, [9, 4])
  assert.deepEqual(errors, ['参照先なし'])
  assert.deepEqual(applied, ['request-1'])

  pendingOpenRequest.value = { requestId: 'request-2', nodeId: 4, projectId: 1 }
  await actions.applyOpenResult({ requestId: 'request-2', nodeId: 4 })
  assert.deepEqual(unavailable, [9])
  assert.deepEqual(applied, ['request-1', 'request-2'])
})

test('ツリー幅Layoutはドラッグ結果を実際の保存処理へ渡す', async () => {
  const { ref } = require('vue')
  const previousWindow = globalThis.window
  const saved = []
  let resizeListener
  globalThis.window = {
    innerWidth: 1200,
    addEventListener: (event, listener) => { if (event === 'resize') resizeListener = listener },
    removeEventListener: () => {},
  }
  try {
    const layoutModule = loadSourceModule('src/useProjectTreePaneLayout.ts', {
      './appPreferences': {
        saveProjectTreePreferences: async (preferences) => { saved.push(preferences) },
      },
    })
    const detached = ref(false)
    const layout = layoutModule.useProjectTreePaneLayout({
      initialPreferences: { ui: { projectTree: { width: 280, detached: false } } },
      detached,
      showPersistenceNotice: () => {},
    })
    layout.setup()
    assert.equal(typeof resizeListener, 'function')
    const event = {
      button: 0,
      pointerId: 8,
      clientX: 300,
      preventDefault: () => {},
      currentTarget: { setPointerCapture: () => {} },
    }
    layout.startProjectTreeResize(event)
    layout.moveProjectTreeResize({ pointerId: 8, clientX: 325 })
    layout.endProjectTreeResize(event)
    await layout.flush()
    assert.equal(layout.projectTreeDisplayWidth.value, 305)
    assert.deepEqual(saved, [{ width: 305, detached: false }])
    await layout.dispose()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
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
  const selection = readFileSync(resolve(projectRoot, 'src/useProjectTreeSelection.ts'), 'utf8')
  const menu = sidebar.match(/<VList v-if="contextNode"[\s\S]*?<\/VList>/)?.[0]
  assert.ok(menu)
  const multiMenu = menu.slice(menu.indexOf('<template v-if="selectedNodes.length > 1">'), menu.indexOf('<template v-else>'))
  const singleMenu = menu.slice(menu.indexOf('<template v-else>'))
  assert.match(multiMenu, /選択した\$\{selectedNodes\.length\}件の登録を解除/)
  assert.doesNotMatch(multiMenu, /VDivider|title="登録を解除"/)
  assert.match(singleMenu, /VDivider[\s\S]*title="登録を解除"/)
  assert.match(selection, /const displayedSelection = validSelection\.filter\(\(id\) => visibleIds\.has\(id\)\)/)
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
  const selection = readFileSync(resolve(projectRoot, 'src/useProjectTreeSelection.ts'), 'utf8')
  const actions = readFileSync(resolve(projectRoot, 'src/useProjectTreeActions.ts'), 'utf8')
  const main = readFileSync(resolve(projectRoot, 'src/useDetachedProjectTreeWindow.ts'), 'utf8')

  assert.match(detachedWindow, /if \(pendingOpenRequestId\) \{[\s\S]*?dockAfterOpenRequest = true/)
  assert.match(detachedWindow, /@open-result-applied="handleOpenResultApplied"/)
  assert.match(detachedWindow, /メイン画面へ接続できないため、ファイルを開けませんでした。/)
  assert.match(detachedWindow, /@unavailable-change="publishUnavailableNodes"/)
  assert.match(selection, /new Set<number>\(options\.expandedFolderIds\)/)
  assert.match(sidebar, /\{ deep: true, immediate: true \}/)
  assert.match(selection, /new Set<number>\(options\.unavailableNodeIds\)/)
  assert.match(actions, /finally \{\s*options\.onOpenResultApplied\(result\.requestId\)/)
  assert.doesNotMatch(sidebar, /if \(result\?\.unavailable\) unavailableNodes\.value/)
  assert.match(actions, /if \(result\.error\) \{\s*if \(result\.unavailable\) next\.add\(result\.nodeId\)/)
  assert.match(main, /watch\(\s*\[options\.busy, options\.documentLocked, options\.documentOrigin, options\.mainCloseInProgress\]/)
  assert.match(main, /projectTreeOpenResult\.value = null/)
  assert.match(main, /if \(result\.error && result\.unavailable\) unavailable\.add\(result\.nodeId\)\s*else if \(!result\.error\) unavailable\.delete\(result\.nodeId\)/)
  assert.match(main, /ファイル操作の結果を分離ツリーへ伝えられませんでした/)
})

test('ツリー幅ドラッグ中だけ遷移を止め、ポインター中は保存を遅らせる', () => {
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const main = readFileSync(resolve(projectRoot, 'src/useProjectTreePaneLayout.ts'), 'utf8')
  const styles = readFileSync(resolve(projectRoot, 'src/styles/project-tree.css'), 'utf8')

  assert.match(app, /:class="\{ 'is-project-tree-resizing': projectTreeResizing \}"/)
  assert.match(main, /setProjectTreeWidth\(projectTreeResizeStart\.startWidth \+ event\.clientX - projectTreeResizeStart\.startX, false\)/)
  assert.match(app, /@lostpointercapture="endProjectTreeResize"/)
  assert.match(main, /projectTreeResizing\.value = false\s*scheduleProjectTreePreferencesSave\(\)/)
  assert.match(main, /if \(persist\) scheduleProjectTreePreferencesSave\(\)/)
  assert.match(styles, /\.app-shell\.is-project-tree-resizing \.project-navigation,[\s\S]*?\.writing-area \{ transition: none; \}/)
})

test('ドラッグ開始時は未実行の幅保存だけを取り消し、終了処理は一度だけ保存する', () => {
  const controller = readFileSync(resolve(projectRoot, 'src/useProjectTreePaneLayout.ts'), 'utf8')
  const sourceFile = ts.createSourceFile('useProjectTreePaneLayout.ts', controller, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
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
    let disposed = false
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

test('プロジェクトツリーStoreは初期読込と更新後再取得を実動作で直列化する', async () => {
  const { useProjectTreeStore } = loadSourceModule('src/useProjectTreeStore.ts')
  const snapshots = [
    { projects: [], nodes: [], activeProjectId: null },
    { projects: [{ id: 1, name: '作品' }], nodes: [], activeProjectId: 1 },
  ]
  let loadCount = 0
  let mutationCount = 0
  const refreshed = []
  const errors = []
  const store = useProjectTreeStore({
    loadSnapshot: async () => snapshots[Math.min(loadCount++, snapshots.length - 1)],
    canMutate: () => true,
    showError: async (error) => { errors.push(String(error)) },
    onSnapshotRefreshed: (snapshot) => { refreshed.push(snapshot) },
  })

  await store.initializeTree()
  assert.equal(store.loading.value, false)
  assert.equal(store.snapshot.value.activeProjectId, null)
  assert.equal(refreshed.length, 1)
  assert.equal(await store.runMutation(async () => { mutationCount += 1 }), true)
  assert.equal(mutationCount, 1)
  assert.equal(store.snapshot.value.activeProjectId, 1)
  assert.equal(store.mutationPending.value, false)
  assert.deepEqual(errors, [])
})

test('プロジェクトツリーStoreは破棄後の遅着DB結果と進捗表示を画面へ反映しない', async () => {
  const { useProjectTreeStore } = loadSourceModule('src/useProjectTreeStore.ts')
  const snapshotDeferred = deferred()
  const refreshed = []
  const errors = []
  const store = useProjectTreeStore({
    loadSnapshot: () => snapshotDeferred.promise,
    canMutate: () => true,
    showError: async (error) => { errors.push(String(error)) },
    onSnapshotRefreshed: (snapshot) => { refreshed.push(snapshot) },
  })

  const initialize = store.initializeTree()
  store.dispose()
  snapshotDeferred.release({ projects: [{ id: 1, name: '遅着' }], nodes: [], activeProjectId: 1 })
  await initialize
  assert.deepEqual(store.snapshot.value, { projects: [], nodes: [], activeProjectId: null })
  assert.deepEqual(refreshed, [])

  const mutationStore = useProjectTreeStore({
    loadSnapshot: async () => ({ projects: [], nodes: [], activeProjectId: null }),
    canMutate: () => true,
    showError: async (error) => { errors.push(String(error)) },
  })
  await mutationStore.initializeTree()
  const action = deferred()
  const mutation = mutationStore.runMutation(() => action.promise)
  mutationStore.dispose()
  action.release()
  assert.equal(await mutation, false)
  await new Promise((resolve) => globalThis.setTimeout(resolve, 300))
  assert.equal(mutationStore.delayedProgress.value, false)

  const rejectedStore = useProjectTreeStore({
    loadSnapshot: async () => ({ projects: [], nodes: [], activeProjectId: null }),
    canMutate: () => true,
    showError: async (error) => { errors.push(String(error)) },
  })
  await rejectedStore.initializeTree()
  const rejectedMutation = rejectedStore.runMutation(async () => {
    throw new Error('破棄後の遅着エラー')
  })
  rejectedStore.dispose()
  assert.equal(await rejectedMutation, false)
  assert.deepEqual(errors, [])

  const refreshDeferred = deferred()
  let refreshLoadCount = 0
  const refreshRaceStore = useProjectTreeStore({
    loadSnapshot: async () => refreshLoadCount++ === 0
      ? { projects: [], nodes: [], activeProjectId: null }
      : refreshDeferred.promise,
    canMutate: () => true,
    showError: async (error) => { errors.push(String(error)) },
  })
  await refreshRaceStore.initializeTree()
  const refreshMutation = refreshRaceStore.runMutation(async () => {})
  await Promise.resolve()
  refreshRaceStore.dispose()
  refreshDeferred.release({ projects: [], nodes: [], activeProjectId: 2 })
  assert.equal(await refreshMutation, false)
})
