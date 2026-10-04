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
    isBusy: () => false,
    onActivateNode: () => {},
    onFocusNode: () => {},
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
    isBusy: () => false,
    onActivateNode: () => {},
    onFocusNode: () => {},
    onDeleteSelection: () => {},
    onEscape: () => {},
  })

  snapshot.value = { ...snapshot.value, nodes: [snapshot.value.nodes[1]] }
  selection.handleSnapshotRefreshed(snapshot.value)

  assert.deepEqual([...selection.unavailableNodes.value], [12])
  assert.deepEqual(unavailableChanges, [[12]])
})

/** 実際の選択Composableへキーを送り、開く要求・フォーカス・選択を検証する。 */
function createTreeKeyboardHarness() {
  const { ref } = require('vue')
  const snapshot = ref({
    projects: [{ id: 1, name: '作品' }, { id: 2, name: '資料' }],
    activeProjectId: 1,
    nodes: [
      { id: 10, projectId: 1, parentId: null, kind: 'folder', name: '章' },
      { id: 11, projectId: 1, parentId: 10, kind: 'folder', name: '節' },
      { id: 12, projectId: 1, parentId: 11, kind: 'file', name: '本文.txt' },
      { id: 13, projectId: 1, parentId: null, kind: 'file', name: 'あとがき.txt' },
      { id: 20, projectId: 2, parentId: null, kind: 'file', name: '資料.txt' },
    ],
  })
  const state = { busy: false, dialogOpen: false, deleted: 0 }
  const activated = []
  const focused = []
  const selection = loadSourceModule('src/useProjectTreeSelection.ts').useProjectTreeSelection({
    snapshot, expandedFolderIds: [], unavailableNodeIds: [],
    onExpandedChange: () => {}, onUnavailableChange: () => {},
    isDialogOpen: () => state.dialogOpen, isBusy: () => state.busy,
    onActivateNode: (node) => {
      activated.push(node.id)
      if (node.kind === 'folder') selection.toggleFolder(node.id)
    },
    onFocusNode: (nodeId, restoreOnly) => focused.push({ nodeId, restoreOnly }),
    onDeleteSelection: () => { state.deleted += 1 }, onEscape: () => {},
  })
  return {
    selection, snapshot, state, activated, focused,
    key(key, modifiers = {}) {
      let prevented = false
      selection.handleTreeKeydown({
        key, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false,
        preventDefault: () => { prevented = true }, ...modifiers,
      })
      return prevented
    },
  }
}

test('ツリーの矢印・Home・Endは開かずに移動し、Enterだけ既存の開く処理を呼ぶ', () => {
  const h = createTreeKeyboardHarness()
  assert.equal(h.selection.focusedNodeId.value, 10)
  h.key('ArrowRight')
  assert.deepEqual([...h.selection.expandedFolders.value], [10])
  h.key('ArrowRight')
  assert.equal(h.selection.focusedNodeId.value, 11)
  h.key('Enter')
  assert.deepEqual(h.activated, [11])
  h.key('ArrowRight')
  assert.equal(h.selection.focusedNodeId.value, 12)
  h.key('ArrowLeft')
  assert.equal(h.selection.focusedNodeId.value, 11)
  h.key('ArrowLeft')
  assert.equal(h.selection.expandedFolders.value.has(11), false)
  h.key('End')
  assert.equal(h.selection.focusedNodeId.value, 13)
  h.key('ArrowDown')
  assert.equal(h.selection.focusedNodeId.value, 13)
  h.key('Home')
  assert.equal(h.selection.focusedNodeId.value, 10)
  h.key('ArrowUp')
  assert.equal(h.selection.focusedNodeId.value, 10)
  assert.deepEqual(h.activated, [11])
  h.key('End')
  h.key('Enter')
  assert.deepEqual(h.activated, [11, 13])
})

test('ツリーはShift範囲選択・Ctrlフォーカス移動・Ctrl Space切替を組み合わせられる', () => {
  const h = createTreeKeyboardHarness()
  h.key('ArrowRight')
  h.key('Home')
  h.key('ArrowDown', { shiftKey: true })
  h.key('ArrowDown', { shiftKey: true })
  assert.deepEqual([...h.selection.selectedNodeIds.value], [10, 11, 13])
  h.key('ArrowUp', { shiftKey: true })
  assert.deepEqual([...h.selection.selectedNodeIds.value], [10, 11])
  h.key('ArrowDown', { ctrlKey: true })
  assert.equal(h.selection.focusedNodeId.value, 13)
  assert.deepEqual([...h.selection.selectedNodeIds.value], [10, 11])
  h.key(' ', { ctrlKey: true })
  assert.deepEqual([...h.selection.selectedNodeIds.value], [10, 11, 13])
  h.key(' ', { ctrlKey: true })
  assert.deepEqual([...h.selection.selectedNodeIds.value], [10, 11])
  h.key('Escape')
  assert.equal(h.selection.selectedNodeIds.value.size, 0)
  assert.equal(h.selection.focusedNodeId.value, 13)
})

test('ツリーは折りたたみ・削除・別画面更新・空ツリーでフォーカスを復帰する', () => {
  const h = createTreeKeyboardHarness()
  h.selection.syncExpandedFolderIds([10, 11])
  h.selection.setFocusedNode(12)
  h.selection.setNodeSelection([12])
  h.selection.syncExpandedFolderIds([])
  assert.equal(h.selection.focusedNodeId.value, 10)
  assert.equal(h.selection.selectedNodeIds.value.size, 0)
  assert.deepEqual(h.focused.at(-1), { nodeId: 10, restoreOnly: true })
  h.selection.syncExpandedFolderIds([10, 11])
  h.selection.setFocusedNode(12)
  h.snapshot.value = { ...h.snapshot.value, nodes: h.snapshot.value.nodes.filter((node) => node.id !== 12) }
  assert.equal(h.selection.focusedNodeId.value, 11)
  h.key('End')
  h.snapshot.value = { ...h.snapshot.value, nodes: h.snapshot.value.nodes.filter((node) => node.id !== 13) }
  assert.equal(h.selection.focusedNodeId.value, 11)
  h.snapshot.value = { ...h.snapshot.value, activeProjectId: 2 }
  assert.equal(h.selection.focusedNodeId.value, 20)
  h.snapshot.value = { ...h.snapshot.value, nodes: [] }
  assert.equal(h.selection.focusedNodeId.value, null)
  assert.doesNotThrow(() => h.key('ArrowDown'))
  assert.deepEqual(h.focused.at(-1), { nodeId: null, restoreOnly: true })
})

test('ツリーのキー操作はIME・入力欄・処理中・ダイアログ中に動かず、操作ボタンのEnterを奪わない', () => {
  const h = createTreeKeyboardHarness()
  const previousHTMLElement = globalThis.HTMLElement
  class TreeKeyTarget {
    constructor(selector) { this.selector = selector }
    closest(selector) { return selector.includes(this.selector) ? this : null }
  }
  globalThis.HTMLElement = TreeKeyTarget
  try {
    for (const modifiers of [{ isComposing: true }, { keyCode: 229 }, { altKey: true },
      { target: new TreeKeyTarget('input') }, { target: new TreeKeyTarget('contenteditable') }]) {
      assert.equal(h.key('ArrowDown', modifiers), false)
      assert.equal(h.key('Enter', modifiers), false)
    }
    h.state.busy = true
    assert.equal(h.key('ArrowDown'), false)
    h.state.busy = false
    h.state.dialogOpen = true
    assert.equal(h.key('ArrowDown'), false)
    h.state.dialogOpen = false
    assert.equal(h.key('Enter', { target: new TreeKeyTarget('.project-tree-actions') }), false)
    assert.equal(h.selection.focusedNodeId.value, 10)
    assert.deepEqual(h.activated, [])
  } finally {
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement
    else globalThis.HTMLElement = previousHTMLElement
  }
  const source = readFileSync(resolve(projectRoot, 'src/ProjectTreeSidebar.vue'), 'utf8')
  assert.equal((source.match(/:tabindex="focusedNodeId === row.node.id \? 0 : -1"/g) ?? []).length, 2)
  assert.match(source, /:tabindex="visibleRows.length === 0 \|\| isBusy \? 0 : -1"/)
  assert.match(source, /scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/)
})

test('ツリーのDOMフォーカス復帰は画面内へスクロールし、外部へ移ったフォーカスを奪わない', async () => {
  const source = readFileSync(resolve(projectRoot, 'src/ProjectTreeSidebar.vue'), 'utf8')
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const sourceFile = ts.createSourceFile('ProjectTreeSidebar.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = sourceFile.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'focusTreeNode')
  assert.ok(declaration)
  const compiled = ts.transpileModule(declaration.getText(sourceFile), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const focusCalls = []
  const scrollCalls = []
  const rowButton = { disabled: false, focus: (options) => focusCalls.push(['row', options]), scrollIntoView: (options) => scrollCalls.push(options) }
  const oldRowButton = {}
  const external = {}
  const document = { body: {}, activeElement: oldRowButton }
  const tree = {
    isConnected: true,
    contains: (element) => [tree, rowButton, oldRowButton].includes(element),
    querySelector: () => rowButton,
    focus: () => focusCalls.push(['tree']), scrollIntoView: (options) => scrollCalls.push(options),
  }
  const focusedNodeId = { value: 12 }
  let dialogOpen = false
  const move = new Function('treeScrollElement', 'focusedNodeId', 'document', 'nextTick', 'isDialogOpen', `${compiled}\nreturn focusTreeNode`)(
    { value: tree }, focusedNodeId, document, () => Promise.resolve(), () => dialogOpen,
  )
  await move(12, false)
  assert.deepEqual(focusCalls, [['row', { preventScroll: true }]])
  assert.deepEqual(scrollCalls, [{ block: 'nearest', inline: 'nearest' }])
  document.activeElement = external
  await move(12, true)
  assert.equal(focusCalls.length, 1)
  document.activeElement = oldRowButton
  const moving = move(12, true)
  document.activeElement = external
  await moving
  assert.equal(focusCalls.length, 1)
  document.activeElement = oldRowButton
  const removedRow = move(12, true)
  document.activeElement = document.body
  await removedRow
  assert.equal(focusCalls.length, 2)
  document.activeElement = oldRowButton
  const staleMove = move(12, false)
  focusedNodeId.value = 13
  await staleMove
  assert.equal(focusCalls.length, 2)
  focusedNodeId.value = null
  await move(null, true)
  assert.deepEqual(focusCalls.at(-1), ['tree'])
  focusedNodeId.value = 12
  const beforeDialog = move(12, true)
  dialogOpen = true
  await beforeDialog
  await move(12, true)
  assert.equal(focusCalls.length, 3)
})

test('操作メニューはキーボード起動で最初の項目へ移り、Esc復帰先とマウス座標を維持する', () => {
  const source = readFileSync(resolve(projectRoot, 'src/ProjectTreeSidebar.vue'), 'utf8')
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const sourceFile = ts.createSourceFile('ProjectTreeSidebar.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = sourceFile.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'openNodeMenu')
  const focusDeclaration = sourceFile.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'focusNodeMenu')
  assert.ok(declaration)
  assert.ok(focusDeclaration)
  const compiled = ts.transpileModule(`${declaration.getText(sourceFile)}\n${focusDeclaration.getText(sourceFile)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  class MenuButton {
    getBoundingClientRect() { return { left: 200, bottom: 140 } }
  }
  const nodeMenuTarget = { value: [0, 0] }
  const nodeMenuActivator = { value: null }
  const nodeMenuOpen = { value: true }
  const calls = []
  const focused = []
  let dialogOpen = false
  const { open, focus } = new Function('openNodeMenuAction', 'nodeMenuTarget', 'HTMLElement', 'nodeMenuActivator', 'nodeMenuList', 'nodeMenuOpen', 'isDialogOpen',
    `let nodeMenuOpenedWithKeyboard = false\n${compiled}\nreturn { open: openNodeMenu, focus: focusNodeMenu }`)(
    (event, node) => { calls.push(node.id); nodeMenuTarget.value = [event.clientX, event.clientY] }, nodeMenuTarget, MenuButton,
    nodeMenuActivator, { value: { focus: (location) => focused.push(location) } }, nodeMenuOpen, () => dialogOpen,
  )
  const button = new MenuButton()
  open({ detail: 0, clientX: 0, clientY: 0, currentTarget: button }, { id: 12 })
  assert.equal(nodeMenuActivator.value, button)
  assert.deepEqual(nodeMenuTarget.value, [200, 140])
  focus()
  assert.deepEqual(focused, ['first'])
  nodeMenuOpen.value = false
  focus()
  nodeMenuOpen.value = true
  dialogOpen = true
  focus()
  dialogOpen = false
  assert.equal(focused.length, 1)
  open({ detail: 1, clientX: 214, clientY: 122, currentTarget: new MenuButton() }, { id: 13 })
  assert.deepEqual(nodeMenuTarget.value, [214, 122])
  focus()
  assert.equal(focused.length, 1)
  assert.deepEqual(calls, [12, 13])
  assert.match(source, /:activator="nodeMenuActivator \?\? undefined" :open-on-click="false"/)
  assert.match(source, /:open-on-arrow="false"/)
  assert.match(source, /@after-enter="focusNodeMenu"/)
  assert.match(source, /isDialogOpen: \(\) => isDialogOpen\(\) \|\| nodeMenuOpen.value/)
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

test('ツリー空欄の右クリックは選択を解除し、ルートへ追加するメニューを開く', async () => {
  const { nextTick, ref } = require('vue')
  const folderCalls = []
  const fileCalls = []
  const actionsModule = loadSourceModule('src/useProjectTreeActions.ts', {
    '@tauri-apps/plugin-dialog': {
      ask: async () => false,
      message: async () => {},
    },
    './textFile': {
      chooseTextFile: async () => 'C:\\drafts\\root.txt',
      fileName: (path) => path.split('\\').at(-1),
    },
    './projectTreeClient': {
      createProjectFolder: async (...args) => { folderCalls.push(args) },
      registerProjectFile: async (...args) => { fileCalls.push(args) },
      registerDroppedProjectFiles: async () => ({ registeredCount: 0, failures: [] }),
      relinkProjectFile: async () => {},
      removeProjectNodes: async () => {},
      renameProjectFolder: async () => {},
    },
  })
  const snapshot = ref({
    projects: [{ id: 1, name: '主作品' }, { id: 2, name: '別作品' }],
    nodes: [],
    activeProjectId: 1,
  })
  let clearSelectionCount = 0
  const actions = actionsModule.useProjectTreeActions({
    snapshot,
    pendingOpenRequest: ref(null),
    documentOrigin: () => null,
    selectedNodes: () => [],
    unavailableNodeIds: () => [],
    isBusy: () => false,
    runMutation: async (action) => { await action(); return true },
    showTreeError: async () => {},
    setUnavailableNodeIds: () => {},
    clearNodeSelection: () => { clearSelectionCount += 1 },
    selectNodeFromContextMenu: () => {},
    expandFolderPath: () => {},
    containsNode: () => false,
    onOpenFile: () => {},
    onOpenResultApplied: () => {},
    onOriginDetached: () => {},
  })
  const event = {
    clientX: 120,
    clientY: 240,
    preventDefaultCalled: false,
    stopPropagationCalled: false,
    preventDefault() { this.preventDefaultCalled = true },
    stopPropagation() { this.stopPropagationCalled = true },
  }

  actions.openRootMenu(event)
  assert.deepEqual(actions.contextTarget.value, { kind: 'root' })
  assert.equal(actions.contextNode.value, null)
  assert.equal(actions.nodeMenuOpen.value, true)
  assert.deepEqual(actions.nodeMenuTarget.value, [120, 240])
  assert.equal(clearSelectionCount, 1)
  assert.equal(event.preventDefaultCalled, true)
  assert.equal(event.stopPropagationCalled, true)

  actions.requestFolderCreate()
  actions.dialogValue.value = 'ルートフォルダ'
  await actions.saveNameDialog()
  assert.deepEqual(folderCalls, [[1, null, 'ルートフォルダ']])

  actions.openRootMenu(event)
  await actions.registerFile()
  assert.deepEqual(fileCalls, [[1, null, 'C:\\drafts\\root.txt']])

  snapshot.value = { ...snapshot.value, activeProjectId: null }
  await nextTick()
  assert.equal(actions.nodeMenuOpen.value, false)

  snapshot.value = { ...snapshot.value, activeProjectId: 1 }
  await nextTick()
  actions.openRootMenu(event)
  assert.equal(actions.nodeMenuOpen.value, true)
  snapshot.value = { ...snapshot.value, activeProjectId: 2 }
  await nextTick()
  assert.equal(actions.nodeMenuOpen.value, false)
  assert.equal(clearSelectionCount, 3)
})

test('フォルダ名入力中のプロジェクト切替でも作成先は入力開始時のプロジェクトを保つ', async () => {
  const { ref } = require('vue')
  const folderCalls = []
  const snapshot = ref({ projects: [{ id: 1 }, { id: 2 }], nodes: [], activeProjectId: 1 })
  const actions = loadSourceModule('src/useProjectTreeActions.ts', {
    './projectTreeClient': {
      createProjectFolder: async (...args) => { folderCalls.push(args) },
    },
  }).useProjectTreeActions({
    snapshot,
    isBusy: () => false,
    runMutation: async (action) => { await action(); return true },
    expandFolderPath: () => {},
  })

  actions.requestFolderCreate()
  actions.dialogValue.value = '第一章'
  snapshot.value = { ...snapshot.value, activeProjectId: 2 }
  await actions.saveNameDialog()
  assert.deepEqual(folderCalls, [[1, null, '第一章']])
})

test('共通名前ダイアログはIME確定Enterを保存せず、通常Enterだけ一度保存する', () => {
  const source = readFileSync(resolve(projectRoot, 'src/ProjectNameDialog.vue'), 'utf8')
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const compiled = ts.transpileModule(script, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const props = { modelValue: true, title: '名前', value: '第一章', disabled: false }
  const events = []
  const saveOnEnter = new Function('defineProps', 'defineEmits', `${compiled}\nreturn saveOnEnter`)(
    () => props, () => (event) => events.push(event),
  )
  let prevented = 0
  const event = { isComposing: false, keyCode: 13, preventDefault: () => { prevented += 1 } }
  saveOnEnter({ ...event, isComposing: true })
  saveOnEnter({ ...event, keyCode: 229 })
  assert.deepEqual(events, [])
  assert.equal(prevented, 0)

  saveOnEnter(event)
  assert.deepEqual(events, ['save'])
  assert.equal(prevented, 1)
  props.disabled = true
  saveOnEnter(event)
  props.disabled = false
  props.value = '  '
  saveOnEnter(event)
  assert.deepEqual(events, ['save'])
  assert.match(source, /@keydown\.enter="saveOnEnter"/)
  const sidebar = readFileSync(resolve(projectRoot, 'src/ProjectTreeSidebar.vue'), 'utf8')
  assert.match(sidebar, /<ProjectNameDialog\s+v-model="dialogOpen"/)
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
    const layoutModule = loadSourceModule('src/useSidebarPaneLayout.ts', {
      './appPreferences': {
        saveSidebarPreferences: async (preferences, detached) => { saved.push({ ...preferences, detached }) },
      },
    })
    const detached = ref(false)
    const layout = layoutModule.useSidebarPaneLayout({
      initialPreferences: { ui: { sidebar: { width: 280, activePanel: 'project', collapsed: false }, projectTree: { detached: false } } },
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
      currentTarget: { setPointerCapture: () => {}, hasPointerCapture: () => false },
    }
    layout.startSidebarResize(event)
    layout.moveSidebarResize({ pointerId: 8, clientX: 325 })
    layout.endSidebarResize({ ...event, clientX: 325 })
    await layout.flush()
    assert.equal(layout.sidebarDisplayWidth.value, 305)
    assert.deepEqual(saved, [{ width: 305, detached: false, collapsed: false, activePanel: 'project' }])
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

test('ツリー空欄はルートメニューへ接続し、行メニューとは分離されている', () => {
  const sidebar = readFileSync(resolve(projectRoot, 'src/ProjectTreeSidebar.vue'), 'utf8')
  const actions = readFileSync(resolve(projectRoot, 'src/useProjectTreeActions.ts'), 'utf8')
  assert.match(sidebar, /@contextmenu="openRootMenu"/)
  assert.match(sidebar, /<VList v-else-if="contextTarget\.kind === 'root'"/)
  assert.match(sidebar, /title="フォルダを追加"[\s\S]*?title="TXTを登録"/)
  assert.match(actions, /type ProjectTreeContextTarget = \{ kind: 'root' \} \| \{ kind: 'node'; nodeId: number \}/)
  assert.match(actions, /function openRootMenu\(event: MouseEvent\)/)
  assert.match(actions, /options\.clearNodeSelection\(\)/)
  assert.match(actions, /contextTarget\.value = \{ kind: 'node', nodeId: node\.id \}/)
})

test('ツリーヘッダーは幅を消費する選択欄を持たず、追加操作をアイコンと説明へ集約する', () => {
  const sidebar = readFileSync(resolve(projectRoot, 'src/ProjectTreeSidebar.vue'), 'utf8')
  const styles = readFileSync(resolve(projectRoot, 'src/styles/project-tree.css'), 'utf8')
  assert.doesNotMatch(sidebar, /<VSelect/)
  assert.doesNotMatch(sidebar, /class="project-tree-toolbar"/)
  assert.match(sidebar, /mdi-folder-plus-outline/)
  assert.match(sidebar, /mdi-file-plus-outline/)
  assert.match(sidebar, /aria-label="フォルダを追加"/)
  assert.match(sidebar, /aria-label="TXTを登録"/)
  assert.match(sidebar, /プロジェクトなし/)
  assert.match(styles, /\.project-tree-heading-row[\s\S]*display: flex/)
  assert.match(styles, /\.project-tree-heading[\s\S]*text-overflow: ellipsis/)
})

test('プロジェクトメニューはSidebarとメニューバーで共通利用し、切替一覧をスクロール可能にする', () => {
  const menu = readFileSync(resolve(projectRoot, 'src/ProjectMenu.vue'), 'utf8')
  const mainMenu = readFileSync(resolve(projectRoot, 'src/MainMenuBar.vue'), 'utf8')
  const sidebar = readFileSync(resolve(projectRoot, 'src/ProjectTreeSidebar.vue'), 'utf8')
  assert.match(mainMenu, /<ProjectMenu[\s\S]*mode="text"/)
  assert.match(sidebar, /<ProjectMenu/)
  assert.match(menu, /新しいプロジェクト/)
  assert.match(menu, /プロジェクトを切り替え/)
  assert.match(menu, /名前を変更/)
  assert.match(menu, /プロジェクトを削除/)
  assert.match(menu, /max-height="320"/)
  assert.match(menu, /aria-checked/)
  assert.ok((menu.match(/:disabled="props\.disabled"/g) ?? []).length >= 2)
})

test('プロジェクトのトップメニューは他のメニューと同じ表示属性と排他開閉を使う', () => {
  const menu = readFileSync(resolve(projectRoot, 'src/ProjectMenu.vue'), 'utf8')
  const mainMenu = readFileSync(resolve(projectRoot, 'src/MainMenuBar.vue'), 'utf8')
  const sidebar = readFileSync(resolve(projectRoot, 'src/ProjectTreeSidebar.vue'), 'utf8')
  const projectState = readFileSync(resolve(projectRoot, 'src/useProjectMenuState.ts'), 'utf8')
  const mainState = readFileSync(resolve(projectRoot, 'src/useMainMenuState.ts'), 'utf8')

  assert.match(menu, /useProjectMenuState/)
  assert.match(menu, /modelValue: toRef\(props, 'modelValue'\)/)
  assert.match(menu, /modelValue: boolean/)
  assert.match(menu, /defineExpose\(\{ closeMenus, closeSubmenu \}\)/)
  assert.match(menu, /:location="props\.mode === 'icon' \? 'bottom start' : undefined"/)
  assert.match(menu, /:transition="props\.mode === 'text' \? false : undefined"/)
  assert.match(menu, /<VList class="project-menu-list" density="compact"/)

  assert.match(mainMenu, /useMainMenuState/)
  assert.match(mainMenu, /closeSubmenu: \(\) => boolean/)
  assert.match(mainMenu, /v-model="projectMenuOpen"/)
  assert.match(sidebar, /<ProjectMenu[\s\S]*v-model="projectMenuOpen"/)
  assert.match(mainState, /function runProjectAction\(action: \(\) => void\)/)
  assert.match(mainMenu, /@create="runProjectAction\(/)
  assert.match(mainMenu, /@select="runProjectAction\(/)
  assert.match(mainMenu, /@rename="runProjectAction\(/)
  assert.match(mainMenu, /@delete="runProjectAction\(/)
  assert.match(mainMenu, /if \(event\.key === 'Escape' && handleEscape\(\)\)/)
  assert.match(mainState, /if \(openMenu\.value === 'project' && options\.closeProjectSubmenu\(\)\) return true/)
  assert.match(projectState, /function closeSubmenu\(\): boolean/)
})

test('プロジェクトメニューとメニューバーの開閉状態を実動作で二段階制御する', async () => {
  const { ref, nextTick } = require('vue')
  const projectStateModule = loadSourceModule('src/useProjectMenuState.ts')
  const mainStateModule = loadSourceModule('src/useMainMenuState.ts')

  const controlledValue = ref(false)
  const updates = []
  const controlled = projectStateModule.useProjectMenuState({
    modelValue: controlledValue,
    onUpdateModelValue: (value) => {
      updates.push(value)
      controlledValue.value = value
    },
  })
  assert.equal(controlled.menuOpen.value, false)
  controlled.menuOpen.value = true
  assert.deepEqual(updates, [true])
  assert.equal(controlledValue.value, true)
  assert.equal(controlled.menuOpen.value, true)
  await nextTick()
  controlled.switchMenuOpen.value = true
  controlled.menuOpen.value = false
  assert.deepEqual(updates, [true, false])
  await nextTick()
  assert.equal(controlled.switchMenuOpen.value, false)

  const projectValue = ref(false)
  const project = projectStateModule.useProjectMenuState({
    modelValue: projectValue,
    onUpdateModelValue: (value) => { projectValue.value = value },
  })
  const main = mainStateModule.useMainMenuState({
    closeProjectSubmenu: project.closeSubmenu,
    closeProjectMenus: project.closeMenus,
  })

  main.fileMenuOpen.value = true
  assert.equal(main.fileMenuOpen.value, true)
  main.projectMenuOpen.value = true
  assert.equal(main.fileMenuOpen.value, false)
  assert.equal(main.projectMenuOpen.value, true)
  project.switchMenuOpen.value = true
  main.settingsMenuOpen.value = true
  assert.equal(main.projectMenuOpen.value, false)
  assert.equal(main.settingsMenuOpen.value, true)
  assert.equal(project.switchMenuOpen.value, false)

  main.projectMenuOpen.value = true
  project.switchMenuOpen.value = true
  assert.equal(main.handleEscape(), true)
  assert.equal(project.switchMenuOpen.value, false)
  assert.equal(main.projectMenuOpen.value, true)
  assert.equal(main.handleEscape(), true)
  assert.equal(main.projectMenuOpen.value, false)

  main.projectMenuOpen.value = true
  project.switchMenuOpen.value = true
  let actionCalled = false
  main.runProjectAction(() => { actionCalled = true })
  assert.equal(actionCalled, true)
  assert.equal(main.projectMenuOpen.value, false)
  assert.equal(project.switchMenuOpen.value, false)

  main.projectMenuOpen.value = true
  project.switchMenuOpen.value = true
  main.closeMenus()
  assert.equal(main.projectMenuOpen.value, false)
  assert.equal(project.switchMenuOpen.value, false)
})

test('プロジェクト操作Composableは作成後自動選択、同一選択の無操作、名称変更、出自解除を実行する', async () => {
  const { ref } = require('vue')
  const calls = []
  const detached = []
  const snapshot = ref({
    projects: [{ id: 1, name: '主作品' }],
    nodes: [],
    activeProjectId: 1,
  })
  const actionsModule = loadSourceModule('src/useProjectTreeProjectActions.ts', {
    '@tauri-apps/plugin-dialog': { ask: async () => true },
    './projectTreeClient': {
      createProject: async (name) => { snapshot.value.projects.push({ id: 2, name }) },
      renameProject: async (projectId, name) => { snapshot.value.projects.find((project) => project.id === projectId).name = name },
      selectProject: async (projectId) => { snapshot.value.activeProjectId = projectId },
      deleteProject: async (projectId) => { snapshot.value.projects = snapshot.value.projects.filter((project) => project.id !== projectId); snapshot.value.activeProjectId = null },
    },
  })
  let clearSelectionCount = 0
  const actions = actionsModule.useProjectTreeProjectActions({
    snapshot,
    isBusy: () => false,
    runMutation: async (action) => { calls.push('mutation'); await action(); return true },
    documentOrigin: () => ({ nodeId: 11, projectId: 2 }),
    clearNodeSelection: () => { clearSelectionCount += 1 },
    onOriginDetached: (nodeId) => { detached.push(nodeId) },
  })

  actions.requestProjectCreate()
  actions.projectDialogValue.value = '副作品'
  await actions.saveProjectDialog()
  assert.equal(snapshot.value.activeProjectId, 2)
  assert.equal(clearSelectionCount, 1)
  const mutationCountAfterCreate = calls.length
  await actions.changeProject(2)
  assert.equal(calls.length, mutationCountAfterCreate)

  actions.requestProjectRename()
  actions.projectDialogValue.value = '副作品・改'
  await actions.saveProjectDialog()
  assert.equal(snapshot.value.projects.find((project) => project.id === 2).name, '副作品・改')

  await actions.requestProjectDelete()
  assert.deepEqual(detached, [11])
})

test('プロジェクトControllerは購読失敗後も初期読込を続け、破棄中の遅着読込を反映しない', async () => {
  const { ref } = require('vue')
  let loadCount = 0
  const controllerModule = loadSourceModule('src/useProjectTreeProjectController.ts', {
    '@tauri-apps/api/event': {
      listen: async () => { throw new Error('購読失敗') },
    },
    './projectTreeClient': {
      loadProjectTreeSnapshot: async () => { loadCount += 1; return { projects: [{ id: 1, name: '読込済み' }], nodes: [], activeProjectId: 1 } },
      notifyProjectTreeChanged: async () => {},
    },
    '@tauri-apps/plugin-dialog': { ask: async () => false },
  })
  const controller = controllerModule.useProjectTreeProjectController({
    disabled: ref(false),
    documentOrigin: ref(null),
    showError: async () => {},
    onOriginDetached: () => {},
  })
  const loggedErrors = []
  const previousConsoleError = globalThis.console.error
  globalThis.console.error = (...args) => { loggedErrors.push(args) }
  try {
    await controller.setup()
  } finally {
    globalThis.console.error = previousConsoleError
  }
  assert.equal(loadCount, 1)
  assert.equal(controller.activeProjectId.value, 1)
  assert.equal(loggedErrors.length, 1)
  controller.dispose()

  const snapshotDeferred = deferred()
  const listeners = []
  let unlistenCount = 0
  const lateControllerModule = loadSourceModule('src/useProjectTreeProjectController.ts', {
    '@tauri-apps/api/event': {
      listen: async (_event, handler) => { listeners.push(handler); return () => { unlistenCount += 1 } },
    },
    './projectTreeClient': {
      loadProjectTreeSnapshot: async () => snapshotDeferred.promise,
      notifyProjectTreeChanged: async () => {},
    },
    '@tauri-apps/plugin-dialog': { ask: async () => false },
  })
  const lateController = lateControllerModule.useProjectTreeProjectController({
    disabled: ref(false),
    documentOrigin: ref(null),
    showError: async () => {},
    onOriginDetached: () => {},
  })
  const setup = lateController.setup()
  await Promise.resolve()
  lateController.dispose()
  snapshotDeferred.release({ projects: [{ id: 2, name: '遅着' }], nodes: [], activeProjectId: 2 })
  await setup
  assert.equal(lateController.projects.value.length, 0)
  assert.equal(listeners.length, 1)
  assert.equal(unlistenCount, 1)
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
  const styles = readFileSync(resolve(projectRoot, 'src/styles/project-tree.css'), 'utf8')

  assert.match(app, /:class="\{ 'is-project-tree-resizing': projectTreeResizing \}"/)
  assert.match(app, /@lostpointercapture="cancelProjectTreeResize"/)
  assert.match(app, /@pointercancel="cancelProjectTreeResize"/)
  assert.match(styles, /\.app-shell\.is-project-tree-resizing \.project-navigation,[\s\S]*?\.writing-area \{ transition: none; \}/)
})

test('プロジェクトツリーStoreは初期読込と更新後再取得を実動作で直列化する', async () => {
  const { useProjectTreeStore } = loadSourceModule('src/useProjectTreeStore.ts', {
    './projectTreeClient': { notifyProjectTreeChanged: async () => {} },
  })
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

test('プロジェクトツリーStoreは変更通知を発信元ごとに無視し、連続通知を最新読込へ集約する', async () => {
  const listeners = []
  let unlistenCount = 0
  let loadCount = 0
  const refreshDeferred = deferred()
  const store = loadSourceModule('src/useProjectTreeStore.ts', {
    '@tauri-apps/api/event': {
      listen: async (_event, handler) => {
        listeners.push(handler)
        return () => { unlistenCount += 1 }
      },
    },
    './projectTreeClient': {
      notifyProjectTreeChanged: async () => {},
    },
  }).useProjectTreeStore({
    sourceId: 'self',
    loadSnapshot: async () => {
      loadCount += 1
      return loadCount === 1 ? { projects: [], nodes: [], activeProjectId: null } : refreshDeferred.promise
    },
    canMutate: () => true,
    showError: async () => {},
  })

  await store.setup()
  await store.initializeTree()
  assert.equal(listeners.length, 1)
  listeners[0]({ payload: { sourceId: 'self', revision: 1 } })
  assert.equal(loadCount, 1)
  listeners[0]({ payload: { sourceId: 'other', revision: 1 } })
  listeners[0]({ payload: { sourceId: 'other', revision: 2 } })
  assert.equal(loadCount, 2)
  refreshDeferred.release({ projects: [{ id: 2, name: '最新' }], nodes: [], activeProjectId: 2 })
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
  assert.equal(store.snapshot.value.activeProjectId, 2)
  store.dispose()
  assert.equal(unlistenCount, 1)
})

test('プロジェクトツリーStoreは古い読込結果を反映せず、最新通知の結果だけを表示する', async () => {
  const listeners = []
  const stale = deferred()
  const latest = deferred()
  let loadCount = 0
  const store = loadSourceModule('src/useProjectTreeStore.ts', {
    '@tauri-apps/api/event': {
      listen: async (_event, handler) => {
        listeners.push(handler)
        return () => {}
      },
    },
    './projectTreeClient': { notifyProjectTreeChanged: async () => {} },
  }).useProjectTreeStore({
    sourceId: 'self',
    loadSnapshot: async () => {
      loadCount += 1
      if (loadCount === 1) return { projects: [{ id: 1, name: '初期' }], nodes: [], activeProjectId: 1 }
      if (loadCount === 2) return stale.promise
      return latest.promise
    },
    canMutate: () => true,
    showError: async () => {},
  })

  await store.setup()
  await store.initializeTree()
  listeners[0]({ payload: { sourceId: 'other', revision: 1 } })
  listeners[0]({ payload: { sourceId: 'other', revision: 2 } })
  stale.release({ projects: [{ id: 2, name: '古い結果' }], nodes: [], activeProjectId: 2 })
  await Promise.resolve()
  assert.equal(store.snapshot.value.activeProjectId, 1)
  latest.release({ projects: [{ id: 3, name: '最新結果' }], nodes: [], activeProjectId: 3 })
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
  assert.equal(store.snapshot.value.activeProjectId, 3)
  store.dispose()
})

test('プロジェクトツリーStoreは古いrefreshの失敗を捨て、Mutation中に要求された最新refreshを完了する', async () => {
  const listeners = []
  let rejectRefreshA
  let rejectLatestRefresh
  const refreshA = { promise: new Promise((_resolve, reject) => { rejectRefreshA = reject }) }
  const refreshB = deferred()
  const refreshLatestError = { promise: new Promise((_resolve, reject) => { rejectLatestRefresh = reject }) }
  const notifications = []
  const errors = []
  let loadCount = 0
  const store = loadSourceModule('src/useProjectTreeStore.ts', {
    '@tauri-apps/api/event': {
      listen: async (_event, handler) => {
        listeners.push(handler)
        return () => {}
      },
    },
    './projectTreeClient': {
      notifyProjectTreeChanged: async (...args) => { notifications.push(args) },
    },
  }).useProjectTreeStore({
    sourceId: 'self',
    loadSnapshot: async () => {
      loadCount += 1
      if (loadCount === 1) return { projects: [{ id: 1, name: '初期' }], nodes: [], activeProjectId: 1 }
      if (loadCount === 2) return refreshA.promise
      if (loadCount === 3) return refreshB.promise
      return refreshLatestError.promise
    },
    canMutate: () => true,
    showError: async (error) => { errors.push(error) },
  })

  await store.setup()
  await store.initializeTree()
  listeners[0]({ payload: { sourceId: 'other', revision: 1 } })
  const mutation = store.runMutation(async () => {})
  await Promise.resolve()
  rejectRefreshA(new Error('古いrefreshの失敗'))
  await Promise.resolve()
  assert.equal(store.treeError.value, '')
  refreshB.release({ projects: [{ id: 2, name: '最新' }], nodes: [], activeProjectId: 2 })
  assert.equal(await mutation, true)
  assert.equal(store.snapshot.value.activeProjectId, 2)
  assert.equal(store.treeError.value, '')
  assert.equal(notifications.length, 1)
  assert.deepEqual(errors, [])

  const latestMutation = store.runMutation(async () => {})
  await Promise.resolve()
  rejectLatestRefresh(new Error('最新refreshの失敗'))
  assert.equal(await latestMutation, false)
  assert.equal(store.treeError.value, 'Error: 最新refreshの失敗')
  assert.deepEqual(errors.map(String), ['Error: 最新refreshの失敗'])
  store.dispose()
})

test('プロジェクトツリーStoreは破棄後の遅着DB結果と進捗表示を画面へ反映しない', async () => {
  const storeMocks = { './projectTreeClient': { notifyProjectTreeChanged: async () => {} } }
  const { useProjectTreeStore } = loadSourceModule('src/useProjectTreeStore.ts', storeMocks)
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

test('DB更新成功は再読込失敗や画面破棄後も他画面へ通知し、更新失敗は通知しない', async () => {
  const notifications = []
  const { useProjectTreeStore } = loadSourceModule('src/useProjectTreeStore.ts', {
    './projectTreeClient': {
      notifyProjectTreeChanged: async (...args) => { notifications.push(args) },
    },
  })
  let loadCount = 0
  const store = useProjectTreeStore({
    sourceId: 'refresh-failure',
    loadSnapshot: async () => {
      if (loadCount++ > 0) throw new Error('再読込失敗')
      return { projects: [], nodes: [], activeProjectId: null }
    },
    canMutate: () => true,
    showError: async () => {},
  })
  await store.initializeTree()
  assert.equal(await store.runMutation(async () => { throw new Error('更新失敗') }), false)
  assert.deepEqual(notifications, [])
  assert.equal(await store.runMutation(async () => {}), false)
  assert.deepEqual(notifications, [['refresh-failure', 1]])
  assert.equal(store.treeError.value, 'Error: 再読込失敗')
  store.dispose()

  const action = deferred()
  const disposedStore = useProjectTreeStore({
    sourceId: 'disposed',
    loadSnapshot: async () => ({ projects: [], nodes: [], activeProjectId: null }),
    canMutate: () => true,
    showError: async () => {},
  })
  await disposedStore.initializeTree()
  const mutation = disposedStore.runMutation(() => action.promise)
  disposedStore.dispose()
  action.release()
  assert.equal(await mutation, false)
  assert.deepEqual(notifications, [['refresh-failure', 1], ['disposed', 1]])
})
