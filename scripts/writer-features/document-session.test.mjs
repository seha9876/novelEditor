/** 本文セッションの状態と復旧await中の破棄を検証する。 */
import {
  assert,
  deferred,
  loadSourceModule,
  projectRoot,
  readFileSync,
  require,
  resolve,
  test,
  TextDecoder,
  TextEncoder,
  ts,
} from './test-support.mjs'

/** 実際の本文変更通知を再現し、ダイアログと保存境界だけをテスト内で制御する。 */
function createDocumentHarness(overrides = {}) {
  const { ref } = require('vue')
  const recoveryWrites = []
  const fileWrites = []
  const errors = []
  const treeResults = []
  const invocations = []
  const diskFiles = new Map()
  const mainCloseInProgress = ref(false)
  const confirmations = []
  const documentApi = loadSourceModule('src/useDocumentSession.ts', {
    './recoveryStore': {
      loadRecoverySnapshot: async () => overrides.snapshot ?? null,
      saveRecoverySnapshot: async (snapshot) => { recoveryWrites.push(snapshot) },
    },
    '@tauri-apps/plugin-dialog': {
      ask: overrides.ask ?? (async () => true),
      message: async (text, options) => {
        confirmations.push({ text, options })
        return overrides.message ? overrides.message(text, options) : '保存せず続ける'
      },
      open: overrides.open ?? (async () => '原稿.txt'),
      save: overrides.save ?? (async () => '保存.txt'),
    },
    '@tauri-apps/plugin-fs': {
      readFile: async (path) => {
        const bytes = overrides.readFile ? await overrides.readFile(path, diskFiles) : diskFiles.get(path) ?? new TextEncoder().encode('保存済み本文')
        diskFiles.set(path, bytes)
        return bytes
      },
    },
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      if (command === 'text_file_inspect') {
        if (overrides.inspect) return overrides.inspect(args.path)
        return diskFiles.has(args.path) ? { kind: 'present', bytes: Array.from(diskFiles.get(args.path)) } : { kind: 'missing' }
      }
      if (command === 'text_file_save_conditional') {
        if (overrides.conditionalSave) return overrides.conditionalSave(args)
        const actual = diskFiles.get(args.path)
        const matches = args.expected.kind === 'missing' ? !actual : actual && JSON.stringify(Array.from(actual)) === JSON.stringify(args.expected.bytes)
        if (!matches) return { kind: 'conflict', disk: actual ? { kind: 'present', bytes: Array.from(actual) } : { kind: 'missing' } }
        const bytes = new Uint8Array(args.bytes)
        fileWrites.push({ path: args.path, bytes })
        await overrides.writeFile?.(args.path, bytes)
        diskFiles.set(args.path, bytes)
        return { kind: 'saved' }
      }
      invocations.push({ command, args })
      return overrides.invoke?.(command, args) ?? { projects: [], nodes: [], activeProjectId: null }
    } },
  })
  let text = ''
  let session
  const editor = ref({
    getText: () => text,
    setDocument: (next) => {
      text = next.replace(/\r\n|\r/g, '\n')
      session.onChange(text)
    },
    focus() {},
    setSearch() {},
    runSearch() {},
  })
  session = documentApi.useDocumentSession({
    editor,
    mainCloseInProgress,
    showPersistenceNotice: (notice) => errors.push(notice),
    showError: async (action, error) => { errors.push({ action, error }) },
    reportProjectTreeOpenResult: (result, sourceWindowId) => treeResults.push({ ...result, sourceWindowId }),
    onFileAccessed: overrides.onFileAccessed,
  })
  return { session, editor: editor.value, recoveryWrites, fileWrites, errors, treeResults, invocations, diskFiles, mainCloseInProgress, confirmations }
}

/** 開いた原稿のディスク内容だけを後から変更できる、外部更新用セッションを用意する。 */
async function createExternalHarness(overrides = {}) {
  const harness = createDocumentHarness({ open: async () => 'C:/原稿.txt', ...overrides })
  await harness.session.initializeRecovery()
  await harness.session.openDocument()
  return harness
}

test('外部更新通知は本文・未保存状態・履歴を変えず、後でを選んでも保存直前に止める', async () => {
  const records = []
  const h = await createExternalHarness({ onFileAccessed: async (path) => { records.push(path) } })
  try {
    h.editor.setDocument('執筆中の本文')
    h.diskFiles.set('C:/原稿.txt', new TextEncoder().encode('外部の変更'))
    await h.session.checkExternalFile()
    assert.equal(h.session.externalState.value, 'changed')
    assert.equal(h.session.externalDialog.value, null)
    assert.equal(h.editor.getText(), '執筆中の本文')
    assert.equal(h.session.dirty.value, true)
    await h.session.reviewExternalFile()
    h.session.deferExternalFile()
    assert.equal(h.session.externalState.value, 'changed')
    await h.session.saveDocument()
    assert.equal(h.fileWrites.length, 0)
    assert.equal(h.session.externalDialog.value.disk.kind, 'present')
    assert.equal(records.length, 1)
  } finally { h.session.dispose() }
})

test('外部更新は未編集でも自動読込せず、同じ内容へ戻ったら通知を解消する', async () => {
  const h = await createExternalHarness()
  try {
    const original = h.diskFiles.get('C:/原稿.txt')
    h.diskFiles.set('C:/原稿.txt', new TextEncoder().encode('外部更新'))
    await h.session.checkExternalFile()
    assert.equal(h.session.dirty.value, false)
    assert.equal(h.editor.getText(), '保存済み本文')
    h.diskFiles.set('C:/原稿.txt', original.slice())
    await h.session.reviewExternalFile()
    assert.equal(h.session.externalState.value, 'unchanged')
    assert.equal(h.session.externalDialog.value, null)
  } finally { h.session.dispose() }
})

test('再読込は取消と不正UTF-8で本文を保持し、成功時だけBOM・改行・出自を更新する', async () => {
  let confirmed = false
  const h = await createExternalHarness({ ask: async () => confirmed })
  try {
    h.session.documentOrigin.value = { nodeId: 4, projectId: 2 }
    h.editor.setDocument('未保存')
    const external = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('新しい\r\n原稿')])
    h.diskFiles.set('C:/原稿.txt', external)
    await h.session.reviewExternalFile()
    await h.session.reloadExternalFile()
    assert.equal(h.editor.getText(), '未保存')
    confirmed = true
    h.diskFiles.set('C:/原稿.txt', new Uint8Array([0xff]))
    await h.session.reloadExternalFile()
    assert.equal(h.editor.getText(), '未保存')
    assert.equal(h.session.externalState.value, 'error')
    assert.equal(h.session.dirty.value, true)
    h.diskFiles.set('C:/原稿.txt', external)
    await h.session.reviewExternalFile()
    await h.session.reloadExternalFile()
    assert.equal(h.editor.getText(), '新しい\n原稿')
    assert.equal(h.session.dirty.value, false)
    assert.deepEqual(h.session.documentOrigin.value, { nodeId: 4, projectId: 2 })
    assert.equal(h.session.externalState.value, 'unchanged')
    await h.session.saveDocument()
    assert.deepEqual(h.fileWrites.at(-1).bytes, external)
    assert.equal(h.recoveryWrites.at(-1), null)
  } finally { h.session.dispose() }
})

test('上書き確認中に外部で再変更されたら書き込まず、新しい内容で再確認する', async () => {
  const confirmation = deferred()
  const h = await createExternalHarness({ ask: () => confirmation.promise })
  try {
    h.editor.setDocument('現在の本文')
    h.diskFiles.set('C:/原稿.txt', new TextEncoder().encode('外部1'))
    await h.session.saveDocument()
    const saving = h.session.overwriteExternalFile()
    h.diskFiles.set('C:/原稿.txt', new TextEncoder().encode('外部2'))
    confirmation.release(true)
    await saving
    assert.equal(h.fileWrites.length, 0)
    assert.equal(new TextDecoder().decode(new Uint8Array(h.session.externalDialog.value.disk.bytes)), '外部2')
    assert.equal(h.session.dirty.value, true)
    await h.session.overwriteExternalFile()
    assert.equal(h.fileWrites.length, 1)
    assert.equal(h.session.dirty.value, false)
    assert.equal(h.session.externalDialog.value, null)
  } finally { confirmation.release(false); h.session.dispose() }
})

test('欠落は自動再作成せず、確認取消・再作成時の競合も本文を保持する', async () => {
  let confirmed = false
  const h = await createExternalHarness({ ask: async () => confirmed })
  try {
    h.diskFiles.delete('C:/原稿.txt')
    await h.session.saveDocument()
    assert.equal(h.session.externalState.value, 'missing')
    await h.session.overwriteExternalFile()
    assert.equal(h.fileWrites.length, 0)
    confirmed = true
    h.diskFiles.set('C:/原稿.txt', new TextEncoder().encode('別のファイル'))
    await h.session.overwriteExternalFile()
    assert.equal(h.fileWrites.length, 0)
    h.diskFiles.delete('C:/原稿.txt')
    await h.session.reviewExternalFile()
    await h.session.overwriteExternalFile()
    assert.equal(h.fileWrites.length, 1)
    assert.equal(h.session.externalState.value, 'unchanged')
  } finally { h.session.dispose() }
})

test('同じ場所への別名保存にも競合確認を適用し、別の場所への成功では通知を解消する', async () => {
  let target = 'c:/原稿.txt'
  const h = await createExternalHarness({ save: async () => target })
  try {
    h.editor.setDocument('保持する本文')
    h.diskFiles.set(target, new TextEncoder().encode('外部変更'))
    await h.session.saveDocumentAs()
    assert.equal(h.fileWrites.length, 0)
    assert.equal(h.session.externalDialog.value.path, target)
    target = 'D:/別名.txt'
    await h.session.saveDocumentAs()
    assert.equal(h.session.path.value, target)
    assert.equal(h.session.externalDialog.value, null)
    assert.equal(h.session.externalState.value, 'unchanged')
    assert.equal(new TextDecoder().decode(h.diskFiles.get(target)), '保持する本文')
  } finally { h.session.dispose() }
})

test('別名保存の検査後に変更された保存先は上書きせず、現在文書の基準も保持する', async () => {
  const h = await createExternalHarness({ conditionalSave: async () => ({ kind: 'conflict', disk: { kind: 'present', bytes: [65] } }) })
  try {
    h.editor.setDocument('現在の本文')
    await h.session.saveDocumentAs()
    assert.equal(h.session.path.value, 'C:/原稿.txt')
    assert.equal(h.session.externalDialog.value.path, '保存.txt')
    assert.equal(h.session.externalState.value, 'unchanged')
    await h.session.reloadExternalFile()
    assert.equal(h.editor.getText(), '現在の本文')
    assert.equal(h.session.dirty.value, true)
  } finally { h.session.dispose() }
})

test('状態確認の失敗は上書きを禁止し、再確認で回復できる', async () => {
  let fail = true
  const h = await createExternalHarness({ inspect: async () => {
    if (fail) throw new Error('アクセス拒否')
    return { kind: 'present', bytes: Array.from(new TextEncoder().encode('保存済み本文')) }
  } })
  try {
    await h.session.saveDocument()
    assert.equal(h.session.externalState.value, 'error')
    assert.match(h.session.externalDialog.value.disk.message, /アクセス拒否/)
    await h.session.overwriteExternalFile()
    assert.equal(h.fileWrites.length, 0)
    fail = false
    await h.session.reviewExternalFile()
    assert.equal(h.session.externalState.value, 'unchanged')
    assert.equal(h.session.externalDialog.value, null)
  } finally { h.session.dispose() }
})

test('確認要求を重複させず、文書切替・保存成功・破棄後の遅着結果は通知しない', async () => {
  for (const operation of ['new', 'save', 'dispose']) {
    const gate = deferred()
    let calls = 0
    const h = await createExternalHarness({ inspect: async () => {
      calls += 1
      return calls === 1 ? gate.promise : { kind: 'present', bytes: Array.from(new TextEncoder().encode('保存済み本文')) }
    } })
    const checking = h.session.checkExternalFile()
    await h.session.checkExternalFile()
    assert.equal(calls, 1)
    if (operation === 'new') await h.session.newDocument()
    if (operation === 'save') await h.session.saveDocument()
    if (operation === 'dispose') h.session.dispose()
    gate.release({ kind: 'missing' })
    await checking
    assert.equal(h.session.externalState.value, 'unchanged')
    h.session.dispose()
  }
})

test('競合確認中の別窓からの文書切替を拒否し、上書き失敗でも保存基準を変えない', async () => {
  const h = await createExternalHarness({ writeFile: async () => { throw new Error('ロック失敗') } })
  try {
    h.editor.setDocument('未保存の原稿')
    h.diskFiles.set('C:/原稿.txt', new TextEncoder().encode('外部原稿'))
    await h.session.saveDocument()
    await h.session.openProjectTreeFile({ nodeId: 1, projectId: 1, requestId: 'blocked' })
    assert.match(h.treeResults.at(-1).error, /別の操作中/)
    await h.session.newDocument()
    assert.equal(h.editor.getText(), '未保存の原稿')
    await h.session.overwriteExternalFile()
    assert.equal(h.session.dirty.value, true)
    assert.equal(h.session.externalState.value, 'changed')
    assert.equal(new TextDecoder().decode(h.diskFiles.get('C:/原稿.txt')), '外部原稿')
    assert.match(String(h.errors.at(-1).error), /ロック失敗/)
    h.session.deferExternalFile()
    await h.session.saveDocument()
    assert.equal(h.session.externalDialog.value.disk.kind, 'present')
    assert.equal(h.fileWrites.length, 1, '失敗した一回の書込要求以外に自動上書きしない')
  } finally { h.session.dispose() }
})

test('上書き確認の遅着した承認は破棄後に保存せず、別名保存の取消でも本文を保持する', async () => {
  const confirmation = deferred()
  const h = await createExternalHarness({ ask: () => confirmation.promise, save: async () => null })
  h.editor.setDocument('保持する原稿')
  h.diskFiles.set('C:/原稿.txt', new TextEncoder().encode('外部原稿'))
  await h.session.saveDocument()
  await h.session.saveDocumentAs()
  assert.equal(h.session.path.value, 'C:/原稿.txt')
  assert.equal(h.session.externalDialog.value.disk.kind, 'present')
  const saving = h.session.overwriteExternalFile()
  h.session.dispose()
  confirmation.release(true)
  await saving
  assert.equal(h.fileWrites.length, 0)
  assert.equal(h.editor.getText(), '保持する原稿')
})

test('通常読込・ツリー・Ctrl+P・履歴・保存・別名保存の成功を履歴へ記録する', async () => {
  const recorded = []
  const treePath = 'C:/ツリー.txt'
  const { session, fileWrites } = createDocumentHarness({
    onFileAccessed: async (path) => { recorded.push(path) },
    invoke: (command) => command === 'project_tree_snapshot'
      ? { nodes: [{ id: 1, projectId: 2, kind: 'file', path: treePath }], projects: [], activeProjectId: 2 }
      : command === 'recent_file_authorize' ? 'D:/履歴.txt' : treePath,
  })
  try {
    await session.initializeRecovery()
    await session.openDocument()
    await session.openProjectTreeFile({ requestId: 'tree', nodeId: 1, projectId: 2 })
    await session.openProjectTreeFile({ requestId: 'quick', nodeId: 1, projectId: 2, expectedPath: treePath })
    assert.equal(await session.openRecentDocument({ id: 5, path: 'D:/履歴.txt' }), true)
    await session.saveDocument()
    await session.saveDocumentAs()
    assert.deepEqual(recorded, ['原稿.txt', treePath, treePath, 'D:/履歴.txt', 'D:/履歴.txt', '保存.txt'])
    assert.equal(fileWrites.length, 2)
  } finally { session.dispose() }
})

test('履歴の同一ファイルは未保存確認・再読込・本文再生成をせず、本文へ戻る', async () => {
  let reads = 0
  let asks = 0
  let focused = 0
  const recorded = []
  const { session, editor, invocations } = createDocumentHarness({
    open: async () => 'C:/原稿.txt',
    readFile: async () => { reads += 1; return new TextEncoder().encode('元の本文') },
    message: async () => { asks += 1; return 'キャンセル' },
    onFileAccessed: async (path) => { recorded.push(path) },
  })
  try {
    await session.initializeRecovery()
    await session.openDocument()
    editor.setDocument('未保存の本文')
    editor.focus = () => { focused += 1 }
    assert.equal(await session.openRecentDocument({ id: 1, path: String.raw`\\?\C:\原稿.txt` }), true)
    assert.equal(editor.getText(), '未保存の本文')
    assert.equal(session.dirty.value, true)
    assert.equal(reads, 1)
    assert.equal(asks, 0)
    assert.equal(focused, 1)
    assert.equal(invocations.length, 0)
    assert.deepEqual(recorded, ['C:/原稿.txt', 'C:/原稿.txt'])
  } finally { session.dispose() }
})

test('履歴読込の取消・欠落・不正UTF-8・許可失敗では本文と記録を変えない', async () => {
  for (const failure of ['cancel', 'missing', 'utf8', 'scope']) {
    const recorded = []
    const { session, editor } = createDocumentHarness({
      message: async () => 'キャンセル',
      onFileAccessed: async (path) => { recorded.push(path) },
      invoke: async () => { if (failure === 'scope') throw new Error('許可されていません'); return 'C:/履歴.txt' },
      readFile: async () => {
        if (failure === 'missing') throw new Error('ファイルがありません')
        return failure === 'utf8' ? new Uint8Array([0xff]) : new TextEncoder().encode('新しい本文')
      },
    })
    try {
      await session.initializeRecovery()
      editor.setDocument('維持する本文')
      const operation = session.openRecentDocument({ id: 1, path: 'C:/履歴.txt' })
      if (failure === 'cancel') assert.equal(await operation, false)
      else await assert.rejects(operation)
      assert.equal(editor.getText(), '維持する本文')
      assert.equal(session.path.value, null)
      assert.equal(session.dirty.value, true)
      assert.deepEqual(recorded, [])
    } finally { session.dispose() }
  }
})

test('履歴保存の失敗は通知だけにし、成功した読込・保存とBOM・改行形式を維持する', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('一行\r\n二行')])
  const { session, errors, fileWrites } = createDocumentHarness({
    readFile: async () => bytes,
    onFileAccessed: async () => { throw new Error('履歴DB失敗') },
    invoke: async () => 'C:/原稿.txt',
  })
  try {
    await session.initializeRecovery()
    assert.equal(await session.openRecentDocument({ id: 1, path: 'C:/原稿.txt' }), true)
    await session.saveDocument()
    assert.equal(session.dirty.value, false)
    assert.deepEqual(fileWrites[0].bytes, bytes)
    assert.equal(errors.length, 2)
    assert.ok(errors.every((error) => typeof error === 'string' && error.includes('履歴DB失敗')))
  } finally { session.dispose() }
})

test('文書の保存取消・書込失敗では履歴を記録しない', async () => {
  for (const cancel of [true, false]) {
    const recorded = []
    const { session, editor } = createDocumentHarness({
      save: async () => cancel ? null : 'C:/保存.txt',
      writeFile: async () => { throw new Error('保存失敗') },
      onFileAccessed: async (path) => { recorded.push(path) },
    })
    try {
      await session.initializeRecovery()
      editor.setDocument('未保存')
      await session.saveDocument()
      assert.equal(session.dirty.value, true)
      assert.deepEqual(recorded, [])
    } finally { session.dispose() }
  }
})

test('履歴の許可待ちで二重読込を防ぎ、破棄後に本文・記録を反映しない', async () => {
  const gate = deferred()
  const recorded = []
  const { session, editor, invocations } = createDocumentHarness({
    invoke: () => gate.promise,
    onFileAccessed: async (path) => { recorded.push(path) },
  })
  await session.initializeRecovery()
  editor.setDocument('維持する本文')
  const opening = session.openRecentDocument({ id: 1, path: 'C:/履歴.txt' })
  assert.equal(await session.openRecentDocument({ id: 2, path: 'C:/別.txt' }), false)
  assert.equal(invocations.length, 1)
  session.dispose()
  gate.release('C:/履歴.txt')
  assert.equal(await opening, false)
  assert.equal(editor.getText(), '維持する本文')
  assert.deepEqual(recorded, [])
})

test('本文セッションは入力基準、表示名、文書出自を一つの状態として更新する', () => {
  const { ref } = require('vue')
  const documentApi = loadSourceModule('src/useDocumentSession.ts', {
    '@tauri-apps/plugin-dialog': { ask: async () => true, open: async () => null, save: async () => null },
    '@tauri-apps/api/core': { invoke: async () => ({ projects: [], nodes: [], activeProjectId: null }) },
    '@tauri-apps/plugin-fs': { exists: async () => false, readFile: async () => new Uint8Array(), writeFile: async () => {} },
    '@tauri-apps/plugin-store': { load: async () => ({}) },
  })
  const text = { value: '' }
  const editor = ref({
    getText: () => text.value,
    setDocument: (next) => { text.value = next },
    focus() {},
    setSearch() {},
    runSearch() {},
  })
  const closeState = ref(false)
  const results = []
  const session = documentApi.useDocumentSession({
    editor,
    mainCloseInProgress: closeState,
    showPersistenceNotice: () => {},
    showError: async () => {},
    reportProjectTreeOpenResult: (result) => results.push(result),
  })

  assert.equal(session.displayName.value, '無題')
  session.onChange('本文')
  assert.equal(session.dirty.value, true)
  session.onChange('')
  assert.equal(session.dirty.value, false)
  session.detachDocumentOrigin(10)
  assert.equal(session.documentOrigin.value, null)
  assert.deepEqual(results, [])
  session.dispose()
})

test('本文セッションは復旧await中の破棄後に本文やフォーカスを更新しない', async () => {
  const { ref } = require('vue')
  const recoveryDeferred = deferred()
  let focusCount = 0
  const documentApi = loadSourceModule('src/useDocumentSession.ts', {
    './recoveryStore': {
      loadRecoverySnapshot: () => recoveryDeferred.promise,
      saveRecoverySnapshot: async () => {},
    },
    '@tauri-apps/plugin-dialog': { ask: async () => true, open: async () => null, save: async () => null },
    '@tauri-apps/api/core': { invoke: async () => ({ projects: [], nodes: [], activeProjectId: null }) },
    '@tauri-apps/plugin-fs': { exists: async () => false, readFile: async () => new Uint8Array(), writeFile: async () => {} },
    '@tauri-apps/plugin-store': { load: async () => ({}) },
  })
  const editor = ref({
    getText: () => '',
    setDocument() {},
    focus() { focusCount += 1 },
    setSearch() {},
    runSearch() {},
  })
  const session = documentApi.useDocumentSession({
    editor,
    mainCloseInProgress: ref(false),
    showPersistenceNotice: () => {},
    showError: async () => {},
    reportProjectTreeOpenResult: () => {},
  })

  const initialize = session.initializeRecovery()
  session.dispose()
  recoveryDeferred.release({
    schemaVersion: 1,
    text: '遅着本文',
    fileName: '遅着.txt',
    lineEnding: '\n',
    hasBom: false,
    updatedAt: new Date().toISOString(),
  })
  assert.equal(await initialize, false)
  assert.equal(editor.value.getText(), '')
  assert.equal(focusCount, 0)
  assert.equal(session.busy.value, true)
  assert.equal(session.documentLocked.value, true)
})

test('空本文の復元も明示保存まで未保存を維持し、元のBOMと改行形式で保存する', async () => {
  const harness = createDocumentHarness({ snapshot: {
    schemaVersion: 1, text: '', fileName: '復元原稿.txt', lineEnding: '\r\n',
    hasBom: true, updatedAt: '2026-09-23T00:00:00Z',
  } })
  const { session, editor, fileWrites, recoveryWrites } = harness
  try {
    await session.initializeRecovery()
    assert.equal(session.path.value, null)
    assert.equal(session.displayName.value, '復元原稿.txt')
    assert.equal(session.dirty.value, true)
    editor.setDocument('一行目\n二行目')
    await session.saveDocument()
    assert.equal(session.dirty.value, false)
    assert.equal(session.path.value, '保存.txt')
    assert.deepEqual([...fileWrites[0].bytes.slice(0, 3)], [0xef, 0xbb, 0xbf])
    assert.equal(new TextDecoder().decode(fileWrites[0].bytes), '一行目\r\n二行目')
    assert.equal(recoveryWrites.at(-1), null)
    assert.deepEqual(harness.errors, [])
  } finally {
    session.dispose()
  }
})

test('保存中の追加入力は未保存として残り、復元候補には最新の本文を保存する', async () => {
  const gate = deferred()
  const started = deferred()
  const { session, editor, fileWrites, recoveryWrites } = createDocumentHarness({
    writeFile: async () => { started.release(); await gate.promise },
  })
  try {
    await session.initializeRecovery()
    editor.setDocument('保存開始時')
    const saving = session.saveDocument()
    await started.promise
    assert.equal(session.busy.value, true)
    assert.equal(session.documentLocked.value, false)
    editor.setDocument('保存開始時からの追記')
    gate.release()
    await saving
    assert.equal(new TextDecoder().decode(fileWrites[0].bytes), '保存開始時')
    assert.equal(session.dirty.value, true)
    assert.equal(recoveryWrites.at(-1).text, '保存開始時からの追記')
    await session.saveDocument()
    assert.equal(session.dirty.value, false)
    assert.equal(recoveryWrites.at(-1), null)
  } finally {
    gate.release()
    session.dispose()
  }
})

test('文書切替の確認を取り消すと本文・保存先・未保存状態と復元候補を維持する', async () => {
  const { session, editor, recoveryWrites } = createDocumentHarness({ message: async () => 'キャンセル' })
  try {
    await session.initializeRecovery()
    await session.openDocument()
    editor.setDocument('編集中の本文')
    const writesBeforeCancel = recoveryWrites.length
    await session.openDocument()
    await session.newDocument()
    assert.equal(editor.getText(), '編集中の本文')
    assert.equal(session.path.value, '原稿.txt')
    assert.equal(session.dirty.value, true)
    assert.equal(recoveryWrites.length, writesBeforeCancel)
    assert.equal(session.busy.value, false)
    assert.equal(session.documentLocked.value, false)
  } finally {
    session.dispose()
  }
})

test('別名保存の失敗は現在の保存先と保存基準を変更しない', async () => {
  const { session, editor, recoveryWrites, errors } = createDocumentHarness({
    writeFile: async () => { throw new Error('書き込み失敗') },
  })
  try {
    await session.initializeRecovery()
    await session.openDocument()
    editor.setDocument('追記した本文')
    const writesBeforeSave = recoveryWrites.length
    await session.saveDocumentAs()
    assert.equal(session.path.value, '原稿.txt')
    assert.equal(session.dirty.value, true)
    assert.equal(recoveryWrites.length, writesBeforeSave)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].action, '保存')
    editor.setDocument('保存済み本文')
    assert.equal(session.dirty.value, false)
    assert.equal(session.busy.value, false)
  } finally {
    session.dispose()
  }
})

test('復元確認ダイアログの失敗では候補を保護し、以後の編集や終了で上書きしない', async () => {
  const { session, editor, recoveryWrites, errors } = createDocumentHarness({
    snapshot: {
      schemaVersion: 1, text: '保護する本文', fileName: '原稿.txt', lineEnding: '\n',
      hasBom: false, updatedAt: '2026-09-23T00:00:00Z',
    },
    ask: async () => { throw new Error('ダイアログ失敗') },
  })
  try {
    await session.initializeRecovery()
    editor.setDocument('新しい本文')
    await session.saveDocument()
    await session.clearRecoverySnapshot()
    assert.deepEqual(recoveryWrites, [])
    assert.equal(errors.length, 1)
    assert.match(errors[0], /前回の候補を保護/)
    assert.equal(session.busy.value, false)
    assert.equal(session.documentLocked.value, false)
  } finally {
    session.dispose()
  }
})

/** 別プロジェクトの検索候補と検証APIを用意し、保存済み本文からの切替を再現する。 */
function createQuickOpenHarness(overrides = {}) {
  const expectedPath = 'C:\\原稿\\候補.txt'
  const request = { requestId: 'quick-open-1', nodeId: 20, projectId: 2, expectedPath }
  const snapshot = {
    projects: [{ id: 1, name: '表示中' }, { id: 2, name: '別の作品' }],
    activeProjectId: 1,
    nodes: [{ id: 20, projectId: 2, kind: 'file', path: expectedPath }],
  }
  const harness = createDocumentHarness({
    ...overrides,
    invoke: overrides.invoke ?? (async (command) => {
      if (command === 'project_tree_snapshot') return snapshot
      if (command === 'project_file_authorize' || command === 'recent_file_authorize') return expectedPath
      throw new Error(`予期しない変更要求: ${command}`)
    }),
  })
  return { ...harness, request, snapshot }
}

test('検索候補を開くと別プロジェクトの出自を保持し、表示中プロジェクトは切り替えない', async () => {
  const { session, editor, request, snapshot, treeResults, invocations } = createQuickOpenHarness()
  try {
    await session.initializeRecovery()
    await session.openProjectTreeFile(request, 'quick-open')
    assert.equal(editor.getText(), '保存済み本文')
    assert.equal(session.path.value, request.expectedPath)
    assert.deepEqual(session.documentOrigin.value, { nodeId: 20, projectId: 2 })
    assert.equal(session.dirty.value, false)
    assert.equal(snapshot.activeProjectId, 1)
    assert.deepEqual(invocations.map(({ command }) => command), ['project_tree_snapshot', 'project_file_authorize'])
    assert.deepEqual(treeResults, [{ requestId: request.requestId, nodeId: 20, outcome: 'opened', sourceWindowId: 'quick-open' }])
  } finally {
    session.dispose()
  }
})

test('通常のツリー要求は検索時パスを要求せず、現在の参照先を開く', async () => {
  const { session, request, treeResults } = createQuickOpenHarness({
    invoke: async (command) => command === 'project_tree_snapshot'
      ? { projects: [], activeProjectId: 1, nodes: [{ id: 20, projectId: 2, kind: 'file', path: 'C:\\変更.txt' }] }
      : 'C:\\変更.txt',
  })
  try {
    await session.initializeRecovery()
    const treeRequest = { requestId: request.requestId, nodeId: request.nodeId, projectId: request.projectId }
    await session.openProjectTreeFile(treeRequest)
    assert.equal(session.path.value, 'C:\\変更.txt')
    assert.equal(treeResults[0].error, undefined)
  } finally {
    session.dispose()
  }
})

for (const scenario of [
  { name: '削除済み', nodes: [], unavailable: true, authorizationCount: 0 },
  { name: '別プロジェクトへ変更済み', nodes: [{ id: 20, projectId: 3, kind: 'file', path: 'C:\\原稿\\候補.txt' }], unavailable: true, authorizationCount: 0 },
  { name: '取得前に再指定済み', nodes: [{ id: 20, projectId: 2, kind: 'file', path: 'C:\\変更.txt' }], unavailable: false, authorizationCount: 0 },
  { name: '取得後に再指定', nodes: [{ id: 20, projectId: 2, kind: 'file', path: 'C:\\原稿\\候補.txt' }], unavailable: false, authorizationCount: 1 },
]) {
  test(`検索候補が${scenario.name}なら本文読込・破棄確認・復元更新を行わない`, async () => {
    let readCount = 0
    let askCount = 0
    const { session, editor, request, treeResults, recoveryWrites, invocations } = createQuickOpenHarness({
      invoke: async (command) => command === 'project_tree_snapshot'
        ? { projects: [], activeProjectId: 1, nodes: scenario.nodes }
        : 'C:\\変更.txt',
      readFile: async () => { readCount += 1; return new TextEncoder().encode('別文書') },
      message: async () => { askCount += 1; return '保存せず続ける' },
    })
    try {
      await session.initializeRecovery()
      editor.setDocument('守るべき未保存本文')
      const writesBefore = recoveryWrites.length
      await session.openProjectTreeFile(request)
      assert.equal(readCount, 0)
      assert.equal(askCount, 0)
      assert.equal(editor.getText(), '守るべき未保存本文')
      assert.equal(session.path.value, null)
      assert.equal(session.documentOrigin.value, null)
      assert.equal(session.dirty.value, true)
      assert.equal(recoveryWrites.length, writesBefore)
      assert.equal(treeResults[0].unavailable, scenario.unavailable)
      assert.match(treeResults[0].error, scenario.unavailable ? /変更/ : /もう一度検索/)
      assert.equal(invocations.filter(({ command }) => command === 'project_file_authorize').length, scenario.authorizationCount)
      assert.equal(session.busy.value, false)
      assert.equal(session.documentLocked.value, false)
    } finally {
      session.dispose()
    }
  })
}

test('検索候補の切替確認取消では本文・保存先・出自・復元候補を保つ', async () => {
  const { session, editor, request, treeResults, recoveryWrites } = createQuickOpenHarness({ message: async () => 'キャンセル' })
  try {
    await session.initializeRecovery()
    await session.openDocument()
    editor.setDocument('編集中の本文')
    const writesBefore = recoveryWrites.length
    await session.openProjectTreeFile(request)
    assert.equal(editor.getText(), '編集中の本文')
    assert.equal(session.path.value, '原稿.txt')
    assert.equal(session.documentOrigin.value, null)
    assert.equal(session.dirty.value, true)
    assert.equal(recoveryWrites.length, writesBefore)
    assert.equal(treeResults[0].error, undefined)
  } finally {
    session.dispose()
  }
})

test('検索候補の読込失敗はダイアログ向けに報告し、未保存本文と復元候補を維持する', async () => {
  let askCount = 0
  const { session, editor, request, treeResults, recoveryWrites, errors } = createQuickOpenHarness({
    readFile: async () => { throw new Error('ファイル読込失敗') },
    message: async () => { askCount += 1; return '保存せず続ける' },
  })
  try {
    await session.initializeRecovery()
    editor.setDocument('保護対象')
    const writesBefore = recoveryWrites.length
    await session.openProjectTreeFile(request)
    assert.equal(editor.getText(), '保護対象')
    assert.equal(session.path.value, null)
    assert.equal(session.dirty.value, true)
    assert.equal(recoveryWrites.length, writesBefore)
    assert.equal(askCount, 0)
    assert.match(treeResults[0].error, /ファイル読込失敗/)
    assert.deepEqual(errors, [])
  } finally {
    session.dispose()
  }
})

test('検索候補の遅延読込中は重複要求を拒否し、破棄後の結果を本文へ反映しない', async () => {
  const started = deferred()
  const gate = deferred()
  const { session, editor, request, treeResults, recoveryWrites } = createQuickOpenHarness({
    readFile: async () => { started.release(); await gate.promise; return new TextEncoder().encode('遅着本文') },
  })
  try {
    await session.initializeRecovery()
    editor.setDocument('元の本文')
    const writesBefore = recoveryWrites.length
    const opening = session.openProjectTreeFile(request)
    await started.promise
    await session.openProjectTreeFile({ ...request, requestId: 'duplicate' })
    assert.equal(treeResults.length, 1)
    assert.match(treeResults[0].error, /別の操作中/)
    session.dispose()
    gate.release()
    await opening
    assert.equal(editor.getText(), '元の本文')
    assert.equal(session.path.value, null)
    assert.equal(recoveryWrites.length, writesBefore)
    assert.equal(treeResults.length, 1)
  } finally {
    gate.release()
    session.dispose()
  }
})

/** Appの実際の終了関数へ文書セッションを接続し、窓の破棄だけをメモリ上で記録する。 */
function createCloseHarness(harness) {
  const script = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const parsed = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true)
  const handler = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleCloseRequested')
  const compiled = ts.transpileModule(handler.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const { ref } = require('vue')
  const calls = []
  const { session, mainCloseInProgress } = harness
  const context = {
    gitHistory: { pending: ref(false) }, sidebarHistory: { pending: ref(false), exporting: ref(false) },
    busy: session.busy, mainCloseInProgress, documentLocked: session.documentLocked,
    confirmDocumentTransition: session.confirmDocumentTransition,
    showPersistenceNotice: text => calls.push(text), showError: async (action) => calls.push(action),
    publishProjectTreeWindowState: async () => calls.push('publish'),
    settingsController: { flush: async () => calls.push('settings') },
    flushProjectTreePreferences: async () => calls.push('preferences'),
    flushDocumentSession: session.flush,
    clearRecoverySnapshot: async () => { calls.push('clear'); await session.clearRecoverySnapshot() },
    closeSearchWindow: async () => calls.push('search-close'),
    closeProjectTreeWindowForExit: async () => calls.push('tree-close'),
    appWindow: { destroy: async () => calls.push('destroy') },
    restoreAfterCloseFailure: () => calls.push('restore'),
    resumeRecoverySave: () => { calls.push('resume'); session.resumeRecoverySave() },
    projectTreeDetached: ref(true), hasProjectTreeWindow: () => true,
    openProjectTreeWindow: async () => calls.push('tree-open'),
  }
  const close = new Function(...Object.keys(context), `${compiled}\nreturn handleCloseRequested`)(...Object.values(context))
  return { close, calls }
}

/** 切替要求の入口を変え、通常読込・履歴・各ツリー要求が共通確認へ到達するか検証する。 */
async function runTransition(h, route) {
  if (route === 'new') return h.session.newDocument()
  if (route === 'open') return h.session.openDocument()
  if (route === 'recent') return h.session.openRecentDocument({ id: 1, path: h.request.expectedPath })
  if (route === 'close') return h.closing.close()
  const request = { ...h.request }
  if (route === 'tree') delete request.expectedPath
  if (route === 'search') request.searchFingerprint = await loadSourceModule('src/sidebarAnalysis.ts').fingerprintBytes(new TextEncoder().encode('保存済み本文'))
  return h.session.openProjectTreeFile(request, route === 'tree' ? 'detached-tree' : route)
}

for (const route of ['new', 'open', 'recent', 'tree', 'quick', 'search', 'close']) {
  for (const choice of ['保存して続ける', '保存せず続ける', 'キャンセル']) {
    test(`${route}の未保存確認で「${choice}」を選ぶと、保存・切替・終了を正しい順序で行う`, async () => {
      const h = createQuickOpenHarness({ message: async () => choice })
      h.closing = createCloseHarness(h)
      try {
        await h.session.initializeRecovery()
        h.editor.setDocument('守る本文')
        const writesBefore = h.recoveryWrites.length
        await runTransition(h, route)
        assert.equal(h.confirmations.length, 1)
        assert.match(h.confirmations[0].text, /無題/)
        assert.deepEqual(h.confirmations[0].options.buttons, { yes: '保存して続ける', no: '保存せず続ける', cancel: 'キャンセル' })
        assert.equal(h.fileWrites.length, choice === '保存して続ける' ? 1 : 0)
        if (h.fileWrites.length) assert.equal(new TextDecoder().decode(h.fileWrites[0].bytes), '守る本文')
        if (choice === 'キャンセル') {
          assert.equal(h.editor.getText(), '守る本文')
          assert.equal(h.session.path.value, null)
          assert.equal(h.session.dirty.value, true)
          assert.equal(h.recoveryWrites.length, writesBefore)
          assert.ok(!h.closing.calls.includes('destroy'))
        } else if (route === 'close') {
          assert.deepEqual(h.closing.calls, ['publish', 'settings', 'preferences', 'clear', 'search-close', 'tree-close', 'destroy'])
        } else {
          assert.equal(h.editor.getText(), route === 'new' ? '' : '保存済み本文')
          assert.equal(h.session.dirty.value, false)
        }
        if (route !== 'close' || choice === 'キャンセル') assert.equal(h.session.documentLocked.value, false)
        assert.equal(h.session.busy.value, false)
        assert.equal(h.mainCloseInProgress.value, false)
        assert.deepEqual(h.errors, [])
      } finally { h.session.dispose() }
    })
  }
}

test('未編集の切替では確認せず、復元した空本文は名前・BOM・改行形式を保って保存する', async () => {
  const clean = createDocumentHarness()
  try {
    await clean.session.initializeRecovery()
    await clean.session.openDocument()
    await clean.session.newDocument()
    await createCloseHarness(clean).close()
    assert.equal(clean.confirmations.length, 0)
  } finally { clean.session.dispose() }
  const saveOptions = []
  const h = createDocumentHarness({
    snapshot: { schemaVersion: 1, text: '', fileName: '復元原稿.txt', lineEnding: '\r\n', hasBom: true, updatedAt: '2026-10-11T00:00:00Z' },
    message: async () => '保存して続ける',
    save: async options => { saveOptions.push(options); return '復元原稿.txt' },
  })
  try {
    await h.session.initializeRecovery()
    await h.session.newDocument()
    assert.match(h.confirmations[0].text, /復元原稿.txt/)
    assert.equal(saveOptions[0].defaultPath, '復元原稿.txt')
    assert.deepEqual([...h.fileWrites[0].bytes], [0xef, 0xbb, 0xbf])
    assert.equal(h.session.dirty.value, false)
  } finally { h.session.dispose() }
})

for (const failure of ['save-cancel', 'write-error', 'changed', 'missing', 'inspect-error', 'write-conflict', 'dialog-error']) {
  for (const route of ['new', 'close']) {
    test(`${route}の保存続行が${failure}なら、本文を残して処理を中止する`, async () => {
      const h = await createExternalHarness({
        message: async () => { if (failure === 'dialog-error') throw new Error('確認失敗'); return '保存して続ける' },
        save: async () => null,
        ...(failure === 'write-error' ? { writeFile: async () => { throw new Error('書込失敗') } } : {}),
        ...(failure === 'inspect-error' ? { inspect: async () => { throw new Error('確認不可') } } : {}),
        ...(failure === 'write-conflict' ? { conditionalSave: async () => ({ kind: 'conflict', disk: { kind: 'missing' } }) } : {}),
      })
      h.closing = createCloseHarness(h)
      try {
        if (failure === 'save-cancel') await h.session.newDocument()
        h.editor.setDocument('保持する本文')
        if (failure === 'changed') h.diskFiles.set('C:/原稿.txt', new TextEncoder().encode('外部変更'))
        if (failure === 'missing') h.diskFiles.delete('C:/原稿.txt')
        const beforePath = h.session.path.value
        const beforeRecovery = h.recoveryWrites.length
        await runTransition(h, route)
        assert.equal(h.editor.getText(), '保持する本文')
        assert.equal(h.session.path.value, beforePath)
        assert.equal(h.session.dirty.value, true)
        assert.equal(h.recoveryWrites.length, beforeRecovery)
        assert.equal(h.session.documentLocked.value, false)
        assert.equal(h.session.busy.value, false)
        assert.ok(!h.closing.calls.includes('clear'))
        assert.ok(!h.closing.calls.includes('search-close'))
        assert.ok(!h.closing.calls.includes('tree-close'))
        assert.ok(!h.closing.calls.includes('destroy'))
        if (route === 'close') assert.deepEqual(h.closing.calls.slice(-3), ['restore', 'publish', 'resume'])
        if (['changed', 'missing', 'inspect-error', 'write-conflict'].includes(failure)) assert.ok(h.session.externalDialog.value)
      } finally { h.session.dispose() }
    })
  }
}

for (const response of ['Cancel', 'キャンセル', '予期しない応答']) {
  test(`確認結果「${response}」は本文・選択・Undo履歴を変えない`, async () => {
    const { EditorState, EditorSelection } = require('@codemirror/state')
    const { history, undo, redo } = require('@codemirror/commands')
    const h = createDocumentHarness({ message: async () => response })
    try {
      await h.session.initializeRecovery()
      let state = EditorState.create({ doc: '原稿', extensions: [history()] })
      h.editor.getText = () => state.doc.toString()
      h.editor.setDocument = () => assert.fail('取消時に本文を再生成しない')
      const dispatch = transaction => { state = transaction.state; h.session.onChange(state.doc.toString()) }
      dispatch(state.update({ changes: { from: 2, insert: 'の続き' }, selection: EditorSelection.range(1, 4) }))
      const previous = state
      await h.session.newDocument()
      assert.equal(state, previous)
      assert.ok(undo({ state, dispatch }))
      assert.equal(state.doc.toString(), '原稿')
      assert.ok(redo({ state, dispatch }))
      assert.equal(state.doc.toString(), '原稿の続き')
      assert.equal(h.fileWrites.length, 0)
    } finally { h.session.dispose() }
  })
}

for (const route of ['open', 'recent', 'tree', 'quick']) {
  test(`${route}の切替先へ保存した場合、確認前の古い本文を開かない`, async () => {
    const target = route === 'open' ? '原稿.txt' : 'C:\\原稿\\候補.txt'
    const h = createQuickOpenHarness({ message: async () => '保存して続ける', save: async () => target })
    try {
      await h.session.initializeRecovery()
      h.editor.setDocument('保存した最新本文')
      await runTransition(h, route)
      assert.equal(h.editor.getText(), '保存した最新本文')
      assert.equal(h.session.path.value, target)
      assert.equal(h.session.dirty.value, false)
      assert.equal(h.fileWrites.length, 1)
      assert.deepEqual(h.errors, [])
    } finally { h.session.dispose() }
  })
}

test('保存後の再読込失敗と検索結果の陳腐化では、保存済みの現在原稿を維持する', async () => {
  for (const failure of ['reread', 'fingerprint', 'path']) {
    let reads = 0
    let authorized = 0
    const target = 'C:\\原稿\\候補.txt'
    const h = createQuickOpenHarness({
      message: async () => '保存して続ける', save: async () => target,
      ...(failure === 'reread' ? { readFile: async () => { if (++reads > 1) throw new Error('再読込失敗'); return new TextEncoder().encode('保存済み本文') } } : {}),
      ...(failure === 'path' ? { invoke: async command => command === 'project_tree_snapshot'
        ? { nodes: [{ id: 20, projectId: 2, kind: 'file', path: target }] }
        : ++authorized === 1 ? target : '別原稿.txt' } : {}),
    })
    try {
      await h.session.initializeRecovery()
      h.editor.setDocument('保存した最新本文')
      await runTransition(h, failure === 'fingerprint' ? 'search' : 'quick')
      assert.equal(h.editor.getText(), '保存した最新本文')
      assert.equal(h.session.path.value, target)
      assert.equal(h.session.dirty.value, false)
      assert.equal(h.treeResults.at(-1).outcome, 'failed')
      assert.match(h.treeResults.at(-1).error, failure === 'reread' ? /再読込失敗/ : /もう一度検索/)
      assert.equal(h.recoveryWrites.at(-1), null)
    } finally { h.session.dispose() }
  }
})

test('確認・保存中は二重の切替と終了を防ぎ、保存完了までロックを維持する', async () => {
  const confirmation = deferred()
  const started = deferred()
  const writing = deferred()
  const h = createQuickOpenHarness({ message: () => confirmation.promise, writeFile: async () => { started.release(); await writing.promise } })
  h.closing = createCloseHarness(h)
  try {
    await h.session.initializeRecovery()
    h.editor.setDocument('未保存本文')
    const operation = h.session.newDocument()
    await h.session.newDocument()
    await h.session.saveDocument()
    await h.closing.close()
    assert.equal(h.confirmations.length, 1)
    assert.equal(h.fileWrites.length, 0)
    confirmation.release('保存して続ける')
    await started.promise
    assert.equal(h.session.busy.value, true)
    assert.equal(h.session.documentLocked.value, true)
    await h.session.openProjectTreeFile(h.request)
    await h.closing.close()
    assert.match(h.treeResults.at(-1).error, /別の操作中/)
    assert.equal(h.closing.calls.length, 0)
    writing.release()
    await operation
    assert.equal(h.editor.getText(), '')
    assert.equal(h.fileWrites.length, 1)
    assert.equal(h.session.documentLocked.value, false)
  } finally { confirmation.release('キャンセル'); writing.release(); h.session.dispose() }
})

test('終了確認中も保存でき、重複終了を抑止し、保存中の追加変更があれば終了を中止する', async () => {
  const started = deferred()
  const writing = deferred()
  const h = createDocumentHarness({ message: async () => '保存して続ける', writeFile: async () => { started.release(); await writing.promise } })
  const closing = createCloseHarness(h)
  try {
    await h.session.initializeRecovery()
    h.editor.setDocument('保存開始時')
    const operation = closing.close()
    await started.promise
    assert.equal(h.mainCloseInProgress.value, true)
    assert.equal(h.session.documentLocked.value, true)
    await closing.close()
    await h.session.newDocument()
    assert.equal(h.confirmations.length, 1)
    // UIはロック済みだが、遅着変更を受けても未保存本文を失わないことを検証する。
    h.editor.setDocument('遅着した追記')
    writing.release()
    await operation
    assert.equal(h.editor.getText(), '遅着した追記')
    assert.equal(h.session.dirty.value, true)
    assert.equal(h.recoveryWrites.at(-1).text, '遅着した追記')
    assert.ok(!closing.calls.includes('destroy'))
    assert.equal(h.session.documentLocked.value, false)
  } finally { writing.release(); h.session.dispose() }
})

test('確認・保存の遅着応答は破棄済みセッションへ本文や終了結果を適用しない', async () => {
  for (const stage of ['confirmation', 'saving']) {
    const started = deferred()
    const gate = deferred()
    const h = createDocumentHarness({
      message: async () => { if (stage === 'confirmation') { started.release(); return gate.promise }; return '保存して続ける' },
      writeFile: async () => { if (stage === 'saving') { started.release(); await gate.promise } },
    })
    try {
      await h.session.initializeRecovery()
      h.editor.setDocument('保護する本文')
      const operation = h.session.newDocument()
      await started.promise
      h.session.dispose()
      gate.release('保存して続ける')
      await operation
      assert.equal(h.editor.getText(), '保護する本文')
      assert.equal(h.session.path.value, null)
      assert.equal(h.session.dirty.value, true)
      assert.equal(h.fileWrites.length, stage === 'confirmation' ? 0 : 1)
      assert.equal(h.recoveryWrites.length, 0)
    } finally { gate.release('キャンセル'); h.session.dispose() }
  }
})

test('競合解決後は切替・終了を再開せず、履歴だけの保存失敗なら原稿保存を成功として扱う', async () => {
  const h = await createExternalHarness({ message: async () => '保存して続ける' })
  const closing = createCloseHarness(h)
  try {
    h.editor.setDocument('現在の原稿')
    h.diskFiles.set('C:/原稿.txt', new TextEncoder().encode('外部の原稿'))
    await closing.close()
    await h.session.overwriteExternalFile()
    assert.equal(h.session.dirty.value, false)
    assert.equal(h.editor.getText(), '現在の原稿')
    assert.ok(!closing.calls.includes('destroy'))
    await closing.close()
    assert.ok(closing.calls.includes('destroy'))
  } finally { h.session.dispose() }
  const historyFailure = createDocumentHarness({ message: async () => '保存して続ける', onFileAccessed: async () => { throw new Error('履歴DB失敗') } })
  try {
    await historyFailure.session.initializeRecovery()
    historyFailure.editor.setDocument('保存する本文')
    await historyFailure.session.newDocument()
    assert.equal(historyFailure.editor.getText(), '')
    assert.equal(historyFailure.fileWrites.length, 1)
    assert.match(historyFailure.errors[0], /履歴DB失敗/)
  } finally { historyFailure.session.dispose() }
})
