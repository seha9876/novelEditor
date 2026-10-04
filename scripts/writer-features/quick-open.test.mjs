/** 登録ファイルの検索順序と、既存文書セッションへの要求・応答の接続を検証する。 */
import { assert, deferred, loadSourceModule, projectRoot, readFileSync, require, resolve, test, ts } from './test-support.mjs'

/** 同名登録と別プロジェクトを含む、保存順のスナップショットを作る。 */
function createSnapshot() {
  return {
    activeProjectId: 1,
    projects: [{ id: 1, name: '作品一' }, { id: 2, name: '作品二' }],
    nodes: [
      { id: 10, projectId: 1, parentId: null, kind: 'folder', name: '第一部', path: null },
      { id: 12, projectId: 1, parentId: null, kind: 'file', name: 'ＡＢＣ１.txt', path: 'C:\\ABC1.txt' },
      { id: 11, projectId: 1, parentId: 10, kind: 'file', name: '星.txt', path: 'C:\\星.txt' },
      { id: 13, projectId: 1, parentId: 10, kind: 'folder', name: '第二章', path: null },
      { id: 14, projectId: 1, parentId: 13, kind: 'file', name: '星.txt', path: 'C:\\星.txt' },
      { id: 20, projectId: 2, parentId: null, kind: 'file', name: '星.txt', path: 'D:\\星.txt' },
    ],
  }
}

test('検索は展開状態に依存しないツリー順で、同一パスの登録と作品を区別する', () => {
  const { createProjectFileCandidates, searchProjectFiles } = loadSourceModule('src/projectFileSearch.ts')
  const snapshot = createSnapshot()
  const before = JSON.stringify(snapshot)
  const candidates = createProjectFileCandidates(snapshot)
  assert.deepEqual(candidates.map((item) => item.nodeId), [11, 14, 12, 20])
  assert.equal(candidates[1].folderPath, '第一部 / 第二章')
  assert.equal(candidates[3].projectName, '作品二')
  assert.deepEqual(searchProjectFiles(candidates, '星', 1, false).candidates.map((item) => item.nodeId), [11, 14])
  assert.equal(searchProjectFiles(candidates, '星', 1, true).total, 3)
  assert.equal(searchProjectFiles(candidates, '', null, false).total, 0)
  assert.equal(searchProjectFiles(candidates, '', null, true).total, 4)
  assert.equal(searchProjectFiles(candidates, '存在しない', 1, false).total, 0)
  assert.equal(searchProjectFiles(candidates, 'abc1', 1, false).candidates[0].name, 'ＡＢＣ１.txt')
  assert.equal(searchProjectFiles(candidates, ' ＡbＣ１ ', 1, false).total, 1)
  assert.equal(JSON.stringify(snapshot), before)
})

test('大量候補は総一致数を維持して100件まで表示し、検索で後方の候補を開ける', () => {
  const { createProjectFileCandidates, searchProjectFiles } = loadSourceModule('src/projectFileSearch.ts')
  const nodes = Array.from({ length: 5000 }, (_, index) => ({
    id: index + 1, projectId: 1, parentId: null, kind: 'file', name: `原稿${index}.txt`, path: `C:/原稿${index}.txt`,
  }))
  const candidates = createProjectFileCandidates({ activeProjectId: 1, projects: [{ id: 1, name: '作品' }], nodes })
  const result = searchProjectFiles(candidates, '原稿', 1, false)
  assert.equal(result.total, 5000)
  assert.equal(result.candidates.length, 100)
  assert.equal(result.candidates.at(-1).nodeId, 100)
  assert.equal(searchProjectFiles(candidates, '原稿4999', 1, false).candidates[0].nodeId, 5000)
})

/** 本物のVue状態で検索画面を動かし、文書を開く境界だけを差し替える。 */
function createQuickOpenHarness(onOpen = async () => {}) {
  const { ref } = require('vue')
  const { useQuickOpenController } = loadSourceModule('src/useQuickOpenController.ts')
  const snapshot = ref(createSnapshot())
  const disabled = ref(false)
  const requests = []
  const controller = useQuickOpenController({ snapshot, disabled,
    openFile: async (request) => { requests.push(request); await onOpen(request) },
  })
  return { controller, snapshot, disabled, requests }
}

test('再表示で条件を初期化し、入力・上下移動・全体切替だけでは本文を開かない', () => {
  const { controller, requests } = createQuickOpenHarness()
  try {
    controller.open()
    assert.equal(controller.selectedNodeId.value, 11)
    controller.moveSelection(-1)
    assert.equal(controller.selectedNodeId.value, 11)
    controller.moveSelection(1)
    assert.equal(controller.selectedNodeId.value, 14)
    controller.query.value = '星'
    controller.allProjects.value = true
    assert.equal(controller.results.value.total, 3)
    const revision = controller.focusRevision.value
    controller.open()
    assert.equal(controller.focusRevision.value, revision + 1)
    assert.equal(controller.query.value, '星')
    controller.close()
    controller.open()
    assert.equal(controller.query.value, '')
    assert.equal(controller.allProjects.value, false)
    assert.deepEqual(requests, [])
  } finally { controller.dispose() }
})

test('表示候補の削除・プロジェクト切替では選択を現在の一覧へ合わせる', () => {
  const { controller, snapshot } = createQuickOpenHarness()
  try {
    controller.open()
    snapshot.value = { ...snapshot.value, nodes: snapshot.value.nodes.filter((node) => node.id !== 11) }
    assert.equal(controller.selectedNodeId.value, 14)
    snapshot.value = { ...snapshot.value, activeProjectId: 2 }
    assert.equal(controller.selectedNodeId.value, 20)
    controller.query.value = '該当なし'
    controller.moveSelection(1)
    assert.equal(controller.selectedNodeId.value, null)
  } finally { controller.dispose() }
})

test('読込要求に選択時のパスを含め、重複決定・閉じる操作・他要求の応答を抑止する', async () => {
  const gate = deferred()
  const { controller, requests } = createQuickOpenHarness(() => gate.promise)
  try {
    controller.open()
    const opening = controller.openSelected()
    await controller.openSelected()
    controller.close()
    controller.moveSelection(1)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].expectedPath, 'C:\\星.txt')
    assert.equal(controller.selectedNodeId.value, 11)
    assert.equal(controller.pending.value, true)
    assert.equal(controller.isOpen.value, true)
    assert.equal(controller.receiveOpenResult({ requestId: 'unrelated', nodeId: 20 }), false)
    assert.equal(controller.receiveOpenResult({ requestId: requests[0].requestId, nodeId: 11 }), true)
    assert.equal(controller.isOpen.value, false)
    gate.release()
    await opening
    assert.equal(controller.error.value, '')
  } finally { gate.release(); controller.dispose() }
})

test('開く失敗は検索画面に残し、条件を直して再試行できる', async () => {
  const gate = deferred()
  const { controller, requests } = createQuickOpenHarness(() => gate.promise)
  try {
    controller.open()
    const opening = controller.openSelected()
    controller.receiveOpenResult({ requestId: requests[0].requestId, nodeId: 11, error: '参照先を再検索してください' })
    gate.release()
    await opening
    assert.equal(controller.isOpen.value, true)
    assert.equal(controller.pending.value, false)
    assert.match(controller.error.value, /再検索/)
    controller.query.value = 'ABC1'
    assert.equal(controller.error.value, '')
    assert.equal(controller.selectedNodeId.value, 12)
    await controller.openSelected()
    assert.equal(requests.length, 2)
    assert.match(controller.error.value, /結果を確認できません/)
  } finally { gate.release(); controller.dispose() }
})

test('ロック中と破棄後は開かず、遅着した成功・失敗で画面を更新しない', async () => {
  const gate = deferred()
  const { controller, disabled, requests } = createQuickOpenHarness(() => gate.promise)
  disabled.value = true
  controller.open()
  assert.equal(controller.isOpen.value, false)
  disabled.value = false
  controller.open()
  const opening = controller.openSelected()
  controller.dispose()
  assert.equal(controller.receiveOpenResult({ requestId: requests[0].requestId, nodeId: 11, error: '遅着' }), false)
  gate.release()
  await opening
  controller.open()
  assert.equal(controller.isOpen.value, false)
  assert.equal(controller.error.value, '')
})

test('Ctrl+Pと2つの新コマンドを登録し、余分な修飾キーやIMEでは実行しない', () => {
  const { findShortcutCommand, getToolbarCommandDefinitions } = loadSourceModule('src/appCommands.ts')
  const event = { key: 'p', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, isComposing: false }
  assert.equal(findShortcutCommand(event)?.id, 'document.quickOpen')
  assert.equal(findShortcutCommand({ ...event, isComposing: true }), undefined)
  assert.equal(findShortcutCommand({ ...event, shiftKey: true }), undefined)
  const eligible = getToolbarCommandDefinitions().map((item) => item.id)
  assert.ok(eligible.includes('document.quickOpen'))
  assert.ok(eligible.includes('view.whitespace.toggle'))
})

test('検索ダイアログはIMEのEscapeだけを窓へ伝播させず、変換確定と通常の決定を区別する', () => {
  const source = readFileSync(resolve(projectRoot, 'src/QuickOpenDialog.vue'), 'utf8')
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const sourceFile = ts.createSourceFile('QuickOpenDialog.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = sourceFile.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'onKeydown')
  assert.ok(declaration)
  const compiled = ts.transpileModule(declaration.getText(sourceFile), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const props = { pending: false, disabled: false }
  const events = []
  const onKeydown = new Function('props', 'emit', 'Element', `${compiled}\nreturn onKeydown`)(
    props, (...event) => events.push(event), class {},
  )
  let prevented = 0
  let stopped = 0
  const event = {
    key: 'Escape', keyCode: 27, isComposing: false, target: null,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    preventDefault: () => { prevented += 1 },
    stopPropagation: () => { stopped += 1 },
  }
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    onKeydown({ ...event, ...composition })
    onKeydown({ ...event, key: 'Enter', ...composition })
    onKeydown({ ...event, key: 'ArrowDown', ...composition })
  }
  assert.equal(stopped, 2)
  assert.equal(prevented, 0, 'IMEの変換取消と確定の既定処理は維持する')
  assert.deepEqual(events, [])

  onKeydown(event)
  assert.equal(stopped, 2, '通常のEscapeはVOverlayの閉じる処理へ渡す')
  assert.equal(prevented, 0)
  assert.deepEqual(events, [])

  onKeydown({ ...event, key: 'Enter', keyCode: 13 })
  assert.equal(prevented, 1)
  assert.deepEqual(events, [['openFile']])
  props.pending = true
  onKeydown({ ...event, key: 'Enter', keyCode: 13 })
  props.pending = false
  props.disabled = true
  onKeydown({ ...event, key: 'Enter', keyCode: 13 })
  assert.equal(prevented, 1)
  assert.deepEqual(events, [['openFile']], '読込中やロック中は決定を繰り返さない')
})
