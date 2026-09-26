/** 保存・復元・検索と、書記素統計・表示設定を追加依存なしで検証する。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder, TextEncoder } from 'node:util'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** TypeScriptをメモリ上で読み込み、Tauri境界だけを差し替えて実際のアプリ処理を検証する。 */
function loadSourceModule(relativePath, mocks = {}, cache = new Map()) {
  const path = resolve(projectRoot, relativePath)
  if (cache.has(path)) return cache.get(path)
  const module = { exports: {} }
  cache.set(path, module.exports)
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const sourceRequire = (specifier) => {
    if (specifier in mocks) return mocks[specifier]
    if (specifier.startsWith('.')) return loadSourceModule(resolve(dirname(path), `${specifier}.ts`), mocks, cache)
    return require(specifier)
  }
  new Function('require', 'module', 'exports', compiled)(sourceRequire, module, module.exports)
  return module.exports
}

/** 復元Storeを固定のテスト用保存先へ接続し、Tauriの入出力だけ差し替える。 */
function loadRecoveryModule(mocks = {}) {
  const cache = new Map()
  const storageLocation = loadSourceModule('src/storageLocation.ts', mocks, cache)
  storageLocation.setActiveStorageDirectory('C:\\storage-test')
  return loadSourceModule('src/recoveryStore.ts', mocks, cache)
}

/** 非同期書き込みを任意の時点で完了させるための待機点を作る。 */
function deferred() {
  let release
  const promise = new Promise((resolvePromise) => { release = resolvePromise })
  return { promise, release }
}

test('Storeの保存先が確定するまでは相対パスへ退避せず、確定後は絶対パスを使う', () => {
  const storage = loadSourceModule('src/storageLocation.ts')
  assert.throws(() => storage.getStorageFilePath('preferences.json'), /保存先が確定する前/)
  storage.setActiveStorageDirectory('D:\\NovelData\\novelEditor-data')
  assert.equal(storage.getStorageFilePath('preferences.json'), 'D:\\NovelData\\novelEditor-data\\preferences.json')
  assert.equal(storage.getStorageFilePath('recovery.json'), 'D:\\NovelData\\novelEditor-data\\recovery.json')
})

test('旧保存先の片付け放棄は引数なしの明示コマンドとして送る', async () => {
  let invocation
  const expectedStatus = { cleanupPending: false }
  const storage = loadSourceModule('src/storageLocation.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      invocation = { command, args }
      return expectedStatus
    } },
  })
  assert.equal(await storage.abandonStorageCleanup(), expectedStatus)
  assert.deepEqual(invocation, { command: 'storage_abandon_cleanup', args: undefined })
})

test('ツリー内のポインター位置は既存の前後・フォルダ内配置を保つ', () => {
  const tree = loadSourceModule('src/projectTree.ts')
  assert.equal(tree.projectTreeRowPlacement('folder', 5, 0, 40), 'before')
  assert.equal(tree.projectTreeRowPlacement('folder', 20, 0, 40), 'inside')
  assert.equal(tree.projectTreeRowPlacement('folder', 35, 0, 40), 'after')
  assert.equal(tree.projectTreeRowPlacement('file', 20, 0, 40), 'after')
  assert.equal(tree.projectTreeRowPlacement('file', 0, 0, 0), 'before')
})

test('ツリー外や境界の許容範囲外では自動スクロールせず、上下端だけ移動量を返す', () => {
  const tree = loadSourceModule('src/projectTree.ts')
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
  const tree = loadSourceModule('src/projectTree.ts')
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
  const tree = loadSourceModule('src/projectTree.ts')
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
  const tree = loadSourceModule('src/projectTree.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      invocation = { command, args }
    } },
  })
  assert.deepEqual(tree.projectTreeSelectionForNodes(new Set([1, 2, 9]), [
    { id: 1, projectId: 7 }, { id: 2, projectId: 7 }, { id: 9, projectId: 8 },
  ], 7), [1, 2])
  assert.deepEqual(tree.projectTreeSelectionForNodes(new Set([1]), [
    { id: 1, projectId: 7 },
  ], null), [])
  await tree.removeProjectNodes([1, 2])
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
  const tree = loadSourceModule('src/projectTree.ts', {
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

test('通常保存と別名保存でUTF-8・BOM・全改行形式と保存後の基準を維持する', async () => {
  const writes = []
  const files = loadSourceModule('src/textFile.ts', {
    '@tauri-apps/plugin-fs': { writeFile: async (path, bytes) => { writes.push({ path, bytes }) } },
  })
  for (const lineEnding of ['\n', '\r\n', '\r']) {
    for (const hasBom of [false, true]) {
      const bytes = files.encodeTextFile('第一章\n星の声🌟', lineEnding, hasBom)
      const original = files.decodeTextFile('原稿.txt', bytes)
      original.editorText = '第一章\n星の声🌟'
      assert.equal(original.hasBom, hasBom)
      assert.equal(original.lineEnding, lineEnding)
      const copy = await files.saveTextFile('別名.txt', original.editorText, lineEnding, hasBom, original)
      assert.deepEqual(writes.at(-1).bytes, bytes)
      assert.equal(copy.path, '別名.txt')
      const edited = await files.saveTextFile('別名.txt', `${copy.editorText}\n続き`, lineEnding, hasBom, copy)
      assert.equal(edited.editorText, `${copy.editorText}\n続き`)
      assert.deepEqual(writes.at(-1).bytes, files.encodeTextFile(edited.editorText, lineEnding, hasBom))
      await files.saveTextFile('別名.txt', edited.editorText, lineEnding, hasBom, edited)
      assert.equal(writes.at(-1).bytes, edited.originalBytes)
    }
  }
  const mixed = files.decodeTextFile('原稿.txt', new TextEncoder().encode('一\r\n二\n三\r四'))
  mixed.editorText = '一\n二\n三\n四'
  await files.saveTextFile('混在の複製.txt', mixed.editorText, mixed.lineEnding, false, mixed)
  assert.equal(writes.at(-1).bytes, mixed.originalBytes)
  assert.throws(() => files.decodeTextFile('不正.txt', new Uint8Array([0xff])))
})

test('保存開始後の本文変更は書き込んだ本文や保存基準に混入せず、失敗時も元の基準を変えない', async () => {
  const gate = deferred()
  let fail = false
  let written
  const files = loadSourceModule('src/textFile.ts', {
    '@tauri-apps/plugin-fs': { writeFile: async (_path, bytes) => {
      written = bytes
      await gate.promise
      if (fail) throw new Error('書き込み失敗')
    } },
  })
  let editorText = '保存開始時'
  const save = files.saveTextFile('新規.txt', editorText, '\n', false)
  editorText += 'の後に追記'
  gate.release()
  const saved = await save
  assert.equal(new TextDecoder().decode(written), '保存開始時')
  assert.notEqual(editorText, saved.editorText)
  fail = true
  await assert.rejects(files.saveTextFile('失敗.txt', editorText, '\n', false, saved))
  assert.equal(saved.path, '新規.txt')
  assert.equal(saved.editorText, '保存開始時')
})

test('復元候補を検証し、元パスを保存せず、空本文も復元対象として保持する', () => {
  const recovery = loadSourceModule('src/recoveryStore.ts')
  const candidate = {
    schemaVersion: 1, text: '', fileName: '原稿.txt', lineEnding: '\r\n',
    hasBom: true, updatedAt: '2026-09-23T00:00:00.000Z', path: 'D:\\private\\原稿.txt',
  }
  const parsed = recovery.parseRecoverySnapshot(candidate)
  assert.equal(parsed.text, '')
  assert.equal(parsed.hasBom, true)
  assert.equal('path' in parsed, false)
  for (const patch of [
    { schemaVersion: 2 }, { text: null }, { fileName: 'D:\\原稿.txt' },
    { lineEnding: 'LF' }, { hasBom: 'true' }, { updatedAt: 'invalid' },
  ]) assert.throws(() => recovery.parseRecoverySnapshot({ ...candidate, ...patch }))
})

test('遅い復元保存・削除・新しい復元保存を要求順に完了し、失敗後も保存を続行する', async () => {
  const gate = deferred()
  const writeStarted = deferred()
  const diskWrites = []
  let inMemory
  let failNextSave = false
  const store = {
    get: async () => inMemory,
    set: async (_key, value) => { inMemory = value },
    delete: async () => { inMemory = undefined },
    save: async () => {
      if (!diskWrites.length) { writeStarted.release(); await gate.promise }
      if (failNextSave) { failNextSave = false; throw new Error('Store書き込み失敗') }
      diskWrites.push(inMemory)
    },
  }
  const recovery = loadRecoveryModule({
    '@tauri-apps/plugin-store': { load: async (path) => {
      assert.equal(path, 'C:\\storage-test\\recovery.json')
      return store
    } },
    '@tauri-apps/plugin-fs': { exists: async () => false },
  })
  assert.equal(await recovery.loadRecoverySnapshot(), null)
  const candidate = { schemaVersion: 1, text: '旧本文', fileName: '原稿.txt', lineEnding: '\n', hasBom: false, updatedAt: '2026-09-23T00:00:00Z' }
  const first = recovery.saveRecoverySnapshot(candidate)
  await writeStarted.promise
  const clear = recovery.saveRecoverySnapshot(null)
  candidate.text = '新本文'
  const latest = recovery.saveRecoverySnapshot(candidate)
  candidate.text = '呼び出し後の変更'
  gate.release()
  await Promise.all([first, clear, latest])
  assert.deepEqual(diskWrites.map((snapshot) => snapshot?.text), ['旧本文', undefined, '新本文'])
  failNextSave = true
  await assert.rejects(recovery.saveRecoverySnapshot(candidate))
  await recovery.saveRecoverySnapshot(null)
  assert.equal(diskWrites.at(-1), undefined)
})

test('初回に復元ファイルがなければStoreを開かず、終了時もファイルを作らない', async () => {
  let loadCount = 0
  const recovery = loadRecoveryModule({
    '@tauri-apps/plugin-fs': { exists: async (path, options) => {
      assert.equal(path, 'C:\\storage-test\\recovery.json')
      assert.equal(options, undefined)
      return false
    } },
    '@tauri-apps/plugin-store': { load: async () => { loadCount += 1; throw new Error('不要なload') } },
  })
  assert.equal(await recovery.loadRecoverySnapshot(), null)
  await recovery.saveRecoverySnapshot(null)
  assert.equal(loadCount, 0)
})

test('loadが破損JSONを空Storeにしてもreloadで検出し、終了時に上書きせず新本文の保存時に再作成する', async () => {
  const original = '{壊れたJSON'
  let disk = original
  let loadCount = 0
  let closeCount = 0
  const activeStores = new Set()
  const recovery = loadRecoveryModule({
    '@tauri-apps/plugin-fs': { exists: async () => true },
    '@tauri-apps/plugin-store': { load: async (_path, options) => {
      loadCount += 1
      if (loadCount > 1) assert.equal(options.createNew, true)
      let value
      // 実APIと同じくloadは成功するが、JSONを読めなければメモリは空のままになる。
      const targetStore = {
        reload: async (reloadOptions) => { assert.deepEqual(reloadOptions, { ignoreDefaults: true }); throw new Error('破損JSON') },
        get: async () => value,
        set: async (_key, snapshot) => { value = snapshot },
        close: async () => { closeCount += 1; activeStores.delete(targetStore) },
        save: async () => { disk = JSON.stringify(value ?? {}) },
      }
      activeStores.add(targetStore)
      return targetStore
    } },
  })
  await assert.rejects(recovery.loadRecoverySnapshot(), /破損JSON/)
  assert.equal(closeCount, 1)
  await recovery.saveRecoverySnapshot(null)
  // plugin-storeが終了時に全resourceを保存する挙動も模倣し、空Storeが登録から外れたことを確認する。
  for (const activeStore of activeStores) await activeStore.save()
  assert.equal(disk, original)
  assert.equal(loadCount, 1)
  await recovery.saveRecoverySnapshot({ schemaVersion: 1, text: '新本文', fileName: '無題.txt', lineEnding: '\n', hasBom: false, updatedAt: '2026-09-23T00:00:00Z' })
  assert.equal(loadCount, 2)
  assert.equal(JSON.parse(disk).text, '新本文')
})

test('一時的な再読込エラーでも空Storeを閉じ、元の候補を維持して読込を再試行できる', async () => {
  const candidate = { schemaVersion: 1, text: '復元する原稿', fileName: '原稿.txt', lineEnding: '\r\n', hasBom: true, updatedAt: '2026-09-23T00:00:00Z' }
  let disk = candidate
  let readFails = true
  let closeCount = 0
  const activeStores = new Set()
  const recovery = loadRecoveryModule({
    '@tauri-apps/plugin-fs': { exists: async () => true },
    '@tauri-apps/plugin-store': { load: async () => {
      let value
      const targetStore = {
        reload: async (options) => {
          assert.deepEqual(options, { ignoreDefaults: true })
          if (readFails) throw new Error('一時的な読込失敗')
          value = disk
        },
        get: async () => value,
        close: async () => { closeCount += 1; activeStores.delete(targetStore) },
        save: async () => { disk = value },
      }
      activeStores.add(targetStore)
      return targetStore
    } },
  })
  await assert.rejects(recovery.loadRecoverySnapshot(), /一時的な読込失敗/)
  await recovery.saveRecoverySnapshot(null)
  for (const activeStore of activeStores) await activeStore.save()
  assert.equal(disk, candidate)
  assert.equal(closeCount, 1)
  readFails = false
  assert.deepEqual(await recovery.loadRecoverySnapshot(), candidate)
})

test('復元ファイルの存在確認に失敗した場合はStoreを開かず、終了時も上書きしない', async () => {
  let loadCount = 0
  const recovery = loadRecoveryModule({
    '@tauri-apps/plugin-fs': { exists: async () => { throw new Error('存在確認失敗') } },
    '@tauri-apps/plugin-store': { load: async () => { loadCount += 1 } },
  })
  await assert.rejects(recovery.loadRecoverySnapshot(), /存在確認失敗/)
  await recovery.saveRecoverySnapshot(null)
  assert.equal(loadCount, 0)
})

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

/** DOM以外は本物のCodeMirror状態を使い、検索・置換・履歴の結合を確認する。 */
function createSearchView(text, query, readOnly = false) {
  const { EditorState, Transaction } = require('@codemirror/state')
  const { history } = require('@codemirror/commands')
  const { SearchQuery, setSearchQuery } = require('@codemirror/search')
  const { createSearchExtensions } = loadSourceModule('src/searchPanel.ts')
  const view = {
    state: EditorState.create({ doc: text, extensions: [createSearchExtensions(), history(), EditorState.readOnly.of(readOnly)] }),
    plugin: () => null,
    dispatch: (transaction) => { view.state = transaction instanceof Transaction ? transaction.state : view.state.update(transaction).state },
  }
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ ...query, literal: true })) })
  return view
}

test('通常検索・日本語・複数行・大小文字・前後の折り返しを処理する', () => {
  const { findNext, findPrevious, getSearchQuery } = require('@codemirror/search')
  const view = createSearchView('星\nStar star\n星', { search: '星' })
  findNext(view)
  assert.equal(view.state.selection.main.from, 0)
  findNext(view)
  assert.equal(view.state.selection.main.from, 12)
  findNext(view)
  assert.equal(view.state.selection.main.from, 0)
  findPrevious(view)
  assert.equal(view.state.selection.main.from, 12)
  for (const [query, expected] of [
    [{ search: 'Star' }, 2], [{ search: 'Star', caseSensitive: true }, 1],
    [{ search: '星\nStar' }, 1], [{ search: '該当なし' }, 0],
  ]) {
    const candidate = createSearchView('星\nStar star\n星', query)
    assert.equal(Array.from(getSearchQuery(candidate.state).getCursor(candidate.state)).length, expected)
  }
  assert.equal(getSearchQuery(createSearchView('星', { search: '[', regexp: true }).state).valid, false)
})

test('正規表現のキャプチャ・ゼロ幅一致・1件置換・全置換をUndo/Redoできる', () => {
  const { replaceAll, findNext, replaceNext } = require('@codemirror/search')
  const { undo, redo } = require('@codemirror/commands')
  const original = '第1章\n第2章'
  const view = createSearchView(original, { search: '第(\\d+)章', replace: 'Chapter $1', regexp: true })
  assert.equal(replaceAll(view), true)
  assert.equal(view.state.doc.toString(), 'Chapter 1\nChapter 2')
  assert.equal(undo(view), true)
  assert.equal(view.state.doc.toString(), original)
  assert.equal(redo(view), true)
  assert.equal(view.state.doc.toString(), 'Chapter 1\nChapter 2')
  const single = createSearchView('星 星', { search: '星', replace: '月' })
  findNext(single)
  replaceNext(single)
  assert.equal(single.state.doc.toString(), '月 星')
  undo(single)
  assert.equal(single.state.doc.toString(), '星 星')
  const zeroWidth = createSearchView('一\n二', { search: '^', replace: '　', regexp: true })
  replaceAll(zeroWidth)
  assert.equal(zeroWidth.state.doc.toString(), '　一\n　二')
  const locked = createSearchView('星', { search: '星', replace: '月' }, true)
  assert.equal(replaceAll(locked), false)
  assert.equal(locked.state.doc.toString(), '星')
})

test('別窓の操作には最新条件を同封し、遅着した入力や重複操作で条件と本文を戻さない', () => {
  const { SearchSession, createSearchConditions } = loadSourceModule('src/searchSession.ts')
  const { updateEditorSearch, runEditorSearchAction } = loadSourceModule('src/searchPanel.ts')
  const session = new SearchSession()
  session.start('first-window')
  session.setLocked(false)
  const view = createSearchView('星 月 星', { search: '星' })
  const command = {
    type: 'action', sessionId: 'first-window', sequence: 2,
    documentRevision: session.documentRevision,
    conditions: { ...createSearchConditions(), search: '月', replace: '太陽' }, action: 'replaceAll',
  }
  const result = session.receive(command)
  updateEditorSearch(view, session.conditions, true)
  runEditorSearchAction(view, result.action)
  assert.equal(view.state.doc.toString(), '星 太陽 星')
  assert.equal(session.receive({ ...command, type: 'change', sequence: 1, conditions: { ...command.conditions, search: '星' } }).accepted, false)
  assert.equal(session.receive(command).accepted, false)
  assert.equal(session.conditions.search, '月')
  command.conditions.search = '送信後の変更'
  assert.equal(session.conditions.search, '月')
})

test('文書切替や確認ダイアログをまたいだ遅延要求と、閉じた窓の要求を実行しない', () => {
  const { SearchSession, createSearchConditions } = loadSourceModule('src/searchSession.ts')
  const session = new SearchSession()
  session.start('first-window')
  session.setLocked(false)
  const command = {
    type: 'action', sessionId: 'first-window', sequence: 1,
    documentRevision: session.documentRevision,
    conditions: { ...createSearchConditions(), search: '星', replace: '月' }, action: 'replaceAll',
  }
  session.setLocked(true)
  assert.equal(session.receive(command).action, undefined)
  session.setLocked(false)
  assert.equal(session.receive({ ...command, sequence: 2 }).action, undefined)
  assert.equal(session.receive({ ...command, sequence: 3, documentRevision: session.documentRevision }).action, 'replaceAll')
  session.stop()
  assert.equal(session.receive({ ...command, sequence: 4 }).accepted, false)
  session.start('second-window')
  assert.equal(session.conditions.search, '星')
  assert.equal(session.receive({ ...command, sequence: 5 }).accepted, false)
  assert.equal(session.receive({ ...command, sessionId: 'second-window', sequence: 1, documentRevision: session.documentRevision }).action, 'replaceAll')
})

test('閉じる直前の条件を保持し、読み込み完了前の閉じる操作では既存条件を失わない', () => {
  const { SearchSession, createSearchConditions } = loadSourceModule('src/searchSession.ts')
  const session = new SearchSession()
  session.start('first-window')
  session.receive({ type: 'close', sessionId: 'first-window', sequence: 1, documentRevision: 0,
    conditions: { ...createSearchConditions(), search: '最後の入力\n次の行', regexp: true } })
  session.stop()
  session.start('second-window')
  session.receive({ type: 'close', sessionId: 'second-window', sequence: 1, documentRevision: -1 })
  assert.equal(session.conditions.search, '最後の入力\n次の行')
  assert.equal(session.conditions.regexp, true)
})

test('外部検索の条件とハイライトを新文書へ適用し、結果更新・ロック・Undoを統合する', () => {
  const { updateEditorSearch, runEditorSearchAction, getEditorSearchStatus } = loadSourceModule('src/searchPanel.ts')
  const { searchPanelOpen } = require('@codemirror/search')
  const { undo } = require('@codemirror/commands')
  const conditions = { search: '星\n月', replace: '朝', caseSensitive: false, regexp: false }
  const view = createSearchView('星\n月', { search: '' })
  updateEditorSearch(view, conditions, true)
  assert.equal(searchPanelOpen(view.state), true)
  assert.equal(getEditorSearchStatus(view), 'found')
  runEditorSearchAction(view, 'replaceAll')
  assert.equal(view.state.doc.toString(), '朝')
  assert.equal(getEditorSearchStatus(view), 'notFound')
  assert.equal(undo(view), true)
  assert.equal(view.state.doc.toString(), '星\n月')
  // EditorPaneと同じく文書ごとに状態を作り直し、検索条件だけを引き継ぐ。
  view.state = createSearchView('新しい章\n星\n月', { search: '' }).state
  updateEditorSearch(view, conditions, true)
  assert.equal(undo(view), false)
  assert.equal(getEditorSearchStatus(view), 'found')
  updateEditorSearch(view, { ...conditions, search: '[', regexp: true }, true)
  assert.equal(getEditorSearchStatus(view), 'invalid')
  runEditorSearchAction(view, 'replaceAll')
  assert.equal(view.state.doc.toString(), '新しい章\n星\n月')
  updateEditorSearch(view, conditions, false)
  assert.equal(searchPanelOpen(view.state), false)
  assert.equal(getEditorSearchStatus(view), 'found')
  const locked = createSearchView('星 星', { search: '星', replace: '月' }, true)
  const before = locked.state.selection.main
  runEditorSearchAction(locked, 'next')
  runEditorSearchAction(locked, 'replaceAll')
  assert.equal(locked.state.selection.main, before)
  assert.equal(locked.state.doc.toString(), '星 星')
})

test('書記素計数は結合文字・異体字・絵文字を1文字として扱い、改行と空白を区別する', () => {
  const { countText } = loadSourceModule('src/textStatistics.ts')
  for (const text of ['', '星', 'か\u3099', 'e\u0301', '葛\u{E0100}', '👍🏽', '🇯🇵', '👨‍👩‍👧‍👦']) {
    const expected = text ? 1 : 0
    assert.deepEqual(countText(text), { characters: expected, withoutWhitespace: expected })
  }
  assert.deepEqual(countText('星 月\t　\u00a0\r\n空\n\r'), { characters: 7, withoutWhitespace: 3 })
  assert.deepEqual(countText('か\n\u3099'), { characters: 2, withoutWhitespace: 2 })
  assert.deepEqual(countText('\r\n\r\n\u0085\u2028\u2029'), { characters: 0, withoutWhitespace: 0 })
  const original = 'か\u3099'
  countText(original)
  assert.equal(original, 'か\u3099')
})

test('現在列は書記素単位とし、書記素内部・タブ・行末も正しく扱う', () => {
  const { countColumn } = loadSourceModule('src/textStatistics.ts')
  const text = 'か\u3099😀\t星'
  assert.deepEqual(Array.from({ length: text.length + 1 }, (_, offset) => countColumn(text, offset)), [1, 1, 2, 2, 3, 4, 5])
  assert.equal(countColumn('', 0), 1)
  assert.equal(countColumn('🇯🇵🇺🇸', 3), 1)
  assert.equal(countColumn('🇯🇵🇺🇸', 4), 2)
})

test('選択は非空範囲を個別に合算し、全文確定値なしでも独立に計算できる', () => {
  const { EditorState, EditorSelection } = require('@codemirror/state')
  const { calculateStatistics } = loadSourceModule('src/editorStatistics.ts')
  const state = EditorState.create({
    doc: 'か\u3099\n星　月\n👍🏽',
    selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(1, 2), EditorSelection.cursor(3), EditorSelection.range(3, 6), EditorSelection.range(9, 11)]),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  })
  const ranges = state.selection.ranges.filter((range) => !range.empty).map((range) => state.doc.sliceString(range.from, range.to))
  const result = calculateStatistics({ documentId: 1, selectionId: 2, selection: { ranges, line: 'か\u3099', offset: 1, lineNumber: 1, lineCount: 3 } })
  assert.equal(result.document, undefined)
  assert.deepEqual(result.selection, { characters: 6, withoutWhitespace: 5 })
  assert.equal(result.column, 1)
  const empty = calculateStatistics({ documentId: 1, selectionId: 3, text: '', selection: { ranges: [], line: '', offset: 0, lineNumber: 1, lineCount: 1 } })
  assert.deepEqual(empty.document, { characters: 0, withoutWhitespace: 0 })
  assert.deepEqual(empty.selection, { characters: 0, withoutWhitespace: 0 })
})

/** Worker境界だけを手動応答にし、実際の予約処理と純粋な計数処理を接続する。 */
function createStatisticsHarness() {
  const { StatisticsController, calculateStatistics } = loadSourceModule('src/editorStatistics.ts')
  const requests = []
  const states = []
  const worker = { postMessage: (request) => requests.push(request), terminate: () => { worker.terminated = true } }
  const controller = new StatisticsController(worker, (state) => states.push(state))
  return {
    controller, worker, requests, states,
    selection: (ranges = [], line = '', offset = 0) => ({ ranges, line, offset, lineNumber: 1, lineCount: 1 }),
    respond: (index) => worker.onmessage({ data: calculateStatistics(requests[index]) }),
  }
}

test('全文要求を250msでまとめ、処理中も最新1件だけを残す', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const h = createStatisticsHarness()
  h.controller.updateDocument('星', h.selection())
  context.mock.timers.tick(249)
  assert.equal(h.requests.length, 0)
  h.controller.updateDocument('星月', h.selection())
  context.mock.timers.tick(250)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].text, '星月')
  h.controller.updateDocument('星月空', h.selection())
  h.controller.updateDocument('星月空海', h.selection())
  context.mock.timers.tick(250)
  assert.equal(h.requests.length, 1)
  h.respond(0)
  assert.equal(h.states.at(-1).document, null)
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].text, '星月空海')
  h.respond(1)
  assert.deepEqual(h.states.at(-1).document, { characters: 4, withoutWhitespace: 4 })
  assert.equal(h.states.at(-1).pending, false)
  h.controller.dispose()
})

test('カーソル移動では全文結果を再利用し、遅い選択結果だけを無視する', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const h = createStatisticsHarness()
  h.controller.updateDocument('星月', h.selection([], '星月', 0))
  context.mock.timers.tick(250)
  h.controller.updateSelection(h.selection(['星'], '星月', 1))
  h.controller.updateSelection(h.selection(['星月'], '星月', 2))
  h.respond(0)
  assert.deepEqual(h.states.at(-1).document, { characters: 2, withoutWhitespace: 2 })
  assert.equal(h.states.at(-1).selection, null)
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].text, undefined)
  h.respond(1)
  assert.deepEqual(h.states.at(-1).selection, { characters: 2, withoutWhitespace: 2 })
  assert.equal(h.states.at(-1).column, 3)
  assert.equal(h.states.at(-1).pending, false)
  h.controller.updateSelection(h.selection())
  assert.equal(h.requests[2].text, undefined)
  h.controller.dispose()
})

test('文書切替は前文書の統計と遅延応答を残さず、破棄後は通知しない', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const h = createStatisticsHarness()
  h.controller.updateDocument('第一章', h.selection())
  context.mock.timers.tick(250)
  h.respond(0)
  h.controller.updateSelection(h.selection(['第一章']))
  h.controller.updateDocument('次', h.selection(), true)
  assert.equal(h.states.at(-1).document, null)
  h.respond(1)
  assert.equal(h.states.at(-1).document, null)
  context.mock.timers.tick(250)
  h.respond(2)
  assert.equal(h.states.at(-1).document.characters, 1)
  const size = h.states.length
  h.controller.dispose()
  h.respond(0)
  assert.equal(h.states.length, size)
  assert.equal(h.worker.terminated, true)
})

test('Worker失敗を統計エラーとして通知し、無限再試行しない', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const h = createStatisticsHarness()
  h.controller.updateDocument('星', h.selection())
  h.worker.onerror({ preventDefault() {} })
  assert.equal(h.states.at(-1).pending, false)
  assert.match(h.states.at(-1).error, /集計に失敗/)
  h.controller.updateDocument('星月', h.selection())
  context.mock.timers.tick(1000)
  assert.equal(h.requests.length, 0)
  assert.equal(h.worker.terminated, true)
})

test('集計失敗後の文書切替は旧確定値を消し、画面破棄後はエラーも通知しない', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const h = createStatisticsHarness()
  h.controller.updateDocument('第一章', h.selection(['第一章'], '第一章', 3))
  context.mock.timers.tick(250)
  h.respond(0)
  assert.equal(h.states.at(-1).document.characters, 3)
  assert.equal(h.states.at(-1).selection.characters, 3)
  assert.equal(h.states.at(-1).column, 4)
  h.worker.onerror({ preventDefault() {} })
  const error = h.states.at(-1).error
  const nextSelection = { ranges: ['新', '本文'], line: '本文', offset: 1, lineNumber: 2, lineCount: 3 }
  h.controller.updateDocument('新\n本文\n', nextSelection, true)
  assert.deepEqual(h.states.at(-1), {
    document: null, selection: null, column: null, selectionRanges: 2,
    line: 2, lineCount: 3, pending: false, error,
  })
  h.controller.updateSelection({ ...nextSelection, ranges: [], lineNumber: 3 })
  assert.equal(h.states.at(-1).selectionRanges, 0)
  assert.equal(h.states.at(-1).line, 3)
  assert.equal(h.states.at(-1).error, error)
  context.mock.timers.tick(1000)
  assert.equal(h.requests.length, 1)
  h.respond(0)
  assert.equal(h.states.at(-1).document, null)
  const notifications = h.states.length
  h.controller.dispose()
  h.controller.updateDocument('破棄後', nextSelection, true)
  h.controller.updateSelection(nextSelection)
  h.worker.onerror({ preventDefault() {} })
  h.worker.onmessageerror()
  h.respond(0)
  assert.equal(h.states.length, notifications)
})

test('旧設定の補完は既存項目を保ち、任意の書体名と数値の境界を扱う', () => {
  const { defaultEditorSettings, normalizeEditorSettings, editorFontCss, isValidTypographyNumber, getTypographyNumberOptions } = loadSourceModule('src/editorSettings.ts')
  const old = normalizeEditorSettings({ wrapMode: 'columns', wrapColumns: 120, narrowWrapBehavior: 'fit' })
  assert.deepEqual(old, { ...defaultEditorSettings, wrapMode: 'columns', wrapColumns: 120, narrowWrapBehavior: 'fit' })
  const custom = normalizeEditorSettings({ ...old, fontFamily: '小説専用書体', fontFallback: 'sans-serif', fontSize: 48, lineHeight: 3 })
  assert.equal(custom.fontFamily, '小説専用書体')
  assert.equal(editorFontCss(custom), '"小説専用書体", sans-serif')
  assert.equal(editorFontCss({ fontFamily: 'A"B\\C', fontFallback: 'serif' }), '"A\\"B\\\\C", serif')
  for (const fontSize of [12, 18, 48]) assert.equal(isValidTypographyNumber('fontSize', fontSize), true)
  for (const fontSize of [11, 49, 18.5, NaN]) assert.equal(normalizeEditorSettings({ fontSize }).fontSize, 18)
  for (const lineHeight of [1, 1.1, 1.9, 3]) assert.equal(isValidTypographyNumber('lineHeight', lineHeight), true)
  for (const lineHeight of [0.9, 3.1, 1.95, Infinity]) assert.equal(normalizeEditorSettings({ lineHeight }).lineHeight, 1.9)
  const fontSizeOptions = getTypographyNumberOptions('fontSize')
  assert.equal(fontSizeOptions.length, 37)
  assert.deepEqual([fontSizeOptions[0], fontSizeOptions.at(-1)], [12, 48])
  assert.ok(fontSizeOptions.every((value) => isValidTypographyNumber('fontSize', value)))
  const lineHeightOptions = getTypographyNumberOptions('lineHeight')
  assert.equal(lineHeightOptions.length, 21)
  assert.deepEqual([lineHeightOptions[0], lineHeightOptions.at(-1)], [1, 3])
  assert.ok(lineHeightOptions.every((value) => isValidTypographyNumber('lineHeight', value)))
  assert.equal(normalizeEditorSettings({ fontFamily: 'bad\nfont', fontFallback: 'other' }).fontFamily, defaultEditorSettings.fontFamily)
})

test('ツールバー数値入力はIME変換中のEnterを確定キーと誤認しない', () => {
  const { shouldCommitTypographyInput } = loadSourceModule('src/editorSettings.ts')
  assert.equal(shouldCommitTypographyInput({ key: 'Enter', isComposing: false, keyCode: 13 }), true)
  assert.equal(shouldCommitTypographyInput({ key: 'Enter', isComposing: true, keyCode: 13 }), false)
  assert.equal(shouldCommitTypographyInput({ key: 'Enter', isComposing: false, keyCode: 229 }), false)
  assert.equal(shouldCommitTypographyInput({ key: 'Escape', isComposing: false, keyCode: 27 }), false)
})

test('プロジェクトツリー設定は旧データを補完し、保存幅を220～480pxに制限する', () => {
  const preferences = loadSourceModule('src/appPreferences.ts', {
    '@tauri-apps/plugin-store': { load: async () => { throw new Error('このテストではStoreを使いません。') } },
  })
  const defaults = preferences.createDefaultApplicationPreferences()
  assert.deepEqual(defaults.ui.projectTree, { width: 280, detached: false })

  const old = preferences.normalizeApplicationPreferences({ schemaVersion: 1, ui: { toolbar: { visible: false } } })
  assert.deepEqual(old.ui.projectTree, { width: 280, detached: false })
  assert.equal(old.ui.toolbar.visible, false)
  assert.equal(preferences.normalizeApplicationPreferences({ ui: { projectTree: { width: 200, detached: true } } }).ui.projectTree.width, 220)
  assert.equal(preferences.normalizeApplicationPreferences({ ui: { projectTree: { width: 700, detached: true } } }).ui.projectTree.width, 480)
  assert.deepEqual(preferences.normalizeApplicationPreferences({ ui: { projectTree: { width: 'wide', detached: 'yes' } } }).ui.projectTree, { width: 280, detached: false })
})

test('バーサイズ設定は旧データを中サイズで補完し、項目ごとの不正値だけを補正する', () => {
  const preferences = loadSourceModule('src/appPreferences.ts', {
    '@tauri-apps/plugin-store': { load: async () => { throw new Error('このテストではStoreを使いません。') } },
  })
  assert.deepEqual(preferences.createDefaultApplicationPreferences().ui.barSizes, { menu: 'medium', toolbar: 'medium', status: 'medium' })
  assert.deepEqual(preferences.normalizeApplicationPreferences({ schemaVersion: 1, ui: { toolbar: { visible: false } } }).ui.barSizes, {
    menu: 'medium', toolbar: 'medium', status: 'medium',
  })
  assert.deepEqual(preferences.normalizeApplicationPreferences({ ui: {
    barSizes: { menu: 'small', toolbar: 'invalid', status: 'large' },
  } }).ui.barSizes, { menu: 'small', toolbar: 'medium', status: 'large' })
  assert.deepEqual(preferences.normalizeInterfaceBarSizes({ menu: 'large', status: null }), {
    menu: 'large', toolbar: 'medium', status: 'medium',
  })
  assert.equal(preferences.interfaceBarSizePresets.small.menu.height, 40)
  assert.equal(preferences.interfaceBarSizePresets.small.toolbar.buttonHeight, 32)
  assert.equal(preferences.interfaceBarSizePresets.medium.toolbar.buttonHeight, 40)
  assert.equal(preferences.interfaceBarSizePresets.medium.toolbar.buttonWidth, 40)
  assert.equal(preferences.interfaceBarSizePresets.medium.toolbar.numberMenuWidth, 30)
  assert.equal(preferences.interfaceBarSizePresets.medium.toolbar.adjustButtonWidth, 32)
  assert.equal(preferences.interfaceBarSizePresets.large.toolbar.buttonHeight, 48)
  assert.equal(preferences.interfaceBarSizePresets.medium.toolbar.height, 60)
  assert.equal(preferences.interfaceBarSizePresets.large.status.height, 44)
})

test('バーサイズ設定の保存はStoreへ正規化済みの実値を書き込む', async () => {
  let storedValue = {
    schemaVersion: 1,
    ui: {
      toolbar: { visible: true, items: [] },
      barSizes: { menu: 'small', toolbar: 'invalid', status: 'large' },
      projectTree: { width: 280, detached: false },
    },
  }
  let setCount = 0
  const store = {
    async get() { return storedValue },
    async set(_key, value) { storedValue = value; setCount += 1 },
    async save() {},
  }
  const mocks = { '@tauri-apps/plugin-store': { load: async () => store } }
  const cache = new Map()
  const storage = loadSourceModule('src/storageLocation.ts', mocks, cache)
  storage.setActiveStorageDirectory('C:\\bar-size-test')
  const preferences = loadSourceModule('src/appPreferences.ts', mocks, cache)
  const initialization = await preferences.initializeApplicationPreferences()
  assert.deepEqual(initialization.preferences.ui.barSizes, { menu: 'small', toolbar: 'medium', status: 'large' })

  await preferences.saveSettingsPreferences(
    initialization.preferences.editor,
    initialization.preferences.ui.toolbar,
    { menu: 'large', toolbar: 'not-a-size', status: 'small' },
  )
  assert.deepEqual(storedValue.ui.barSizes, { menu: 'large', toolbar: 'medium', status: 'small' })
  assert.ok(setCount >= 2)
})

test('バーサイズとツールバー初期化の境界を純粋関数で保持する', () => {
  const mocks = {
    '@tauri-apps/plugin-store': { load: async () => { throw new Error('このテストではStoreを使いません。') } },
  }
  const cache = new Map()
  const preferences = loadSourceModule('src/appPreferences.ts', mocks, cache)
  const source = {
    toolbar: { visible: false, items: [{ type: 'separator', id: 'custom-separator' }] },
    barSizes: { menu: 'small', toolbar: 'large', status: 'small' },
  }
  const clonedBarSizes = preferences.cloneInterfaceBarSizes(source.barSizes)
  clonedBarSizes.menu = 'large'
  const reset = preferences.resetInterfaceBarSizes()
  const toolbarReset = preferences.resetToolbarPreferences(source.toolbar)
  assert.equal(clonedBarSizes.menu, 'large')
  assert.equal(source.barSizes.menu, 'small')
  assert.deepEqual(reset, { menu: 'medium', toolbar: 'medium', status: 'medium' })
  assert.equal(toolbarReset.visible, false)
  assert.deepEqual(toolbarReset.items, preferences.createDefaultToolbarItems())
  assert.deepEqual(source.toolbar.items, [{ type: 'separator', id: 'custom-separator' }])
  assert.deepEqual(source.barSizes, { menu: 'small', toolbar: 'large', status: 'small' })
})

test('バーサイズ設定は設定画面・状態通信・メインレイアウトへ接続される', () => {
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const settings = readFileSync(resolve(projectRoot, 'src/SettingsApp.vue'), 'utf8')
  const session = readFileSync(resolve(projectRoot, 'src/settingsSession.ts'), 'utf8')
  const definitions = readFileSync(resolve(projectRoot, 'src/settingsDefinitions.ts'), 'utf8')
  const styles = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')
  const barPage = readFileSync(resolve(projectRoot, 'src/BarSizeSettingsPage.vue'), 'utf8')

  assert.match(app, /:height="interfaceBarMetrics\.menu\.height"/)
  assert.match(app, /:extension-height="interfaceBarMetrics\.toolbar\.height"/)
  assert.match(app, /:height="interfaceBarMetrics\.status\.height"/)
  assert.match(app, /barSizes: \{ \.\.\.barSizes\.value \}/)
  assert.match(settings, /page\.id === 'appearance\.bars'/)
  assert.match(settings, /const barSizes = resetInterfaceBarSizes\(\)/)
  assert.match(session, /barSizes\?: Partial<InterfaceBarSizes>/)
  assert.match(definitions, /appearance\.bars\.sizes/)
  assert.match(barPage, /mandatory/)
  assert.match(styles, /--toolbar-control-height/)
  assert.match(styles, /toolbar-typography-number-menu\.v-btn\.v-btn--icon/)
  assert.match(styles, /statistics-button\.v-btn/)
  assert.match(styles, /height: var\(--status-bar-height, 36px\)/)
})

test('バーサイズの初期化範囲は全設定とツールバー構成で分離される', () => {
  const settings = readFileSync(resolve(projectRoot, 'src/SettingsApp.vue'), 'utf8')
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const mediumPreset = readFileSync(resolve(projectRoot, 'src/appPreferences.ts'), 'utf8')

  assert.match(settings, /const barSizes = resetInterfaceBarSizes\(\)/)
  assert.match(settings, /barSizes,\s*flush: true/)
  assert.match(settings, /const toolbar = resetToolbarPreferences\(snapshot\.value\.toolbar\)/)
  assert.doesNotMatch(settings.slice(settings.indexOf('function confirmToolbarDefaults'), settings.indexOf('/** 全設定初期化の確認画面を開く。')), /barSizes/)
  assert.match(app, /function cloneCurrentSettings\(\): SettingsValues/)
  assert.match(app, /updateCurrentSettings\(previous\.editor, previous\.toolbar, false, false, previous\.barSizes\)/)
  assert.match(app, /updateCurrentSettings\(next\.editor, next\.toolbar, false, false, next\.barSizes\)/)
  assert.match(mediumPreset, /medium:\s*\{[\s\S]*?menu: \{ height: 48, controlHeight: 28[\s\S]*?toolbar: \{ height: 60, controlHeight: 36, buttonHeight: 40, buttonWidth: 40/)
})

test('本文書式コントロールをツールバーへ一度ずつ登録でき、既定構成は維持する', () => {
  const commands = loadSourceModule('src/appCommands.ts')
  const preferences = loadSourceModule('src/appPreferences.ts', {
    '@tauri-apps/plugin-store': { load: async () => { throw new Error('このテストではStoreを使いません。') } },
  })
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

test('分離ツリーは開く結果を反映してからドックし、復帰時に展開状態を引き継ぐ', () => {
  const detachedWindow = readFileSync(resolve(projectRoot, 'src/ProjectTreeWindow.vue'), 'utf8')
  const sidebar = readFileSync(resolve(projectRoot, 'src/ProjectTreeSidebar.vue'), 'utf8')
  const main = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')

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
  assert.match(main, /const mainCloseInProgress = ref\(false\)/)
  assert.match(main, /watch\(\[busy, documentLocked, documentOrigin, mainCloseInProgress\]/)
  assert.match(main, /projectTreeOpenResult\.value = null/)
  assert.match(main, /if \(result\.error && result\.unavailable\) unavailable\.add\(result\.nodeId\)\s*else if \(!result\.error\) unavailable\.delete\(result\.nodeId\)/)
  assert.match(main, /ファイル操作の結果を分離ツリーへ伝えられませんでした/)
})

test('ツリー幅ドラッグ中だけ遷移を止め、ポインター中は保存を遅らせる', () => {
  const main = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const styles = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(main, /:class="\{ 'is-project-tree-resizing': projectTreeResizing \}"/)
  assert.match(main, /setProjectTreeWidth\(projectTreeResizeStart\.startWidth \+ event\.clientX - projectTreeResizeStart\.startX, false\)/)
  assert.match(main, /@lostpointercapture="endProjectTreeResize"/)
  assert.match(main, /projectTreeResizing\.value = false\s*scheduleProjectTreePreferencesSave\(\)/)
  assert.match(main, /if \(persist\) scheduleProjectTreePreferencesSave\(\)/)
  assert.match(styles, /\.app-shell\.is-project-tree-resizing \.project-navigation,[\s\S]*?\.writing-area \{ transition: none; \}/)
})

test('ドラッグ開始時は未実行の幅保存だけを取り消し、終了処理は一度だけ保存する', () => {
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const setupScript = app.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(setupScript)
  const sourceFile = ts.createSourceFile('App.vue.ts', setupScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
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

test('保存先エラー画面の閉じる操作は現在のウィンドウを閉じ、失敗だけを表示する', async () => {
  const component = readFileSync(resolve(projectRoot, 'src/StorageStartup.vue'), 'utf8')
  const styles = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')
  const setupScript = component.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(setupScript)
  const sourceFile = ts.createSourceFile('StorageStartup.vue.ts', setupScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let closeFunction
  const findCloseFunction = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'closeStartupWindow') {
      closeFunction = node.getText(sourceFile)
    }
    ts.forEachChild(node, findCloseFunction)
  }
  findCloseFunction(sourceFile)
  assert.ok(closeFunction)

  const executable = ts.transpileModule(`
    ${closeFunction}
    return closeStartupWindow
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const createCloseHandler = new Function('appWindow', 'closeErrorMessage', executable)
  let closeCount = 0
  const closeErrorMessage = { value: '' }
  const close = createCloseHandler({ close: async () => { closeCount += 1 } }, closeErrorMessage)
  await close()
  assert.equal(closeCount, 1)
  assert.equal(closeErrorMessage.value, '')

  const failingClose = createCloseHandler({ close: async () => { throw new Error('終了できません') } }, closeErrorMessage)
  await failingClose()
  assert.equal(closeErrorMessage.value, 'Error: 終了できません')
  assert.match(component, /<VAppBar class="titlebar storage-startup-titlebar"/)
  assert.match(component, /aria-label="閉じる" title="閉じる" @click="closeStartupWindow"/)
  assert.match(component, /v-if="closeErrorMessage"[\s\S]*?ウィンドウを閉じられませんでした/)
  assert.match(styles, /\.storage-startup-main \{[^}]*overflow-y: auto;/)
})
