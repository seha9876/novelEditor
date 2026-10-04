/** 本文セッションの状態と復旧await中の破棄を検証する。 */
import {
  assert,
  deferred,
  loadSourceModule,
  require,
  test,
  TextDecoder,
  TextEncoder,
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
  const documentApi = loadSourceModule('src/useDocumentSession.ts', {
    './recoveryStore': {
      loadRecoverySnapshot: async () => overrides.snapshot ?? null,
      saveRecoverySnapshot: async (snapshot) => { recoveryWrites.push(snapshot) },
    },
    '@tauri-apps/plugin-dialog': {
      ask: overrides.ask ?? (async () => true),
      open: overrides.open ?? (async () => '原稿.txt'),
      save: overrides.save ?? (async () => '保存.txt'),
    },
    '@tauri-apps/plugin-fs': {
      readFile: async (path) => {
        const bytes = overrides.readFile ? await overrides.readFile(path) : diskFiles.get(path) ?? new TextEncoder().encode('保存済み本文')
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
    mainCloseInProgress: ref(false),
    showPersistenceNotice: (notice) => errors.push(notice),
    showError: async (action, error) => { errors.push({ action, error }) },
    reportProjectTreeOpenResult: (result, sourceWindowId) => treeResults.push({ ...result, sourceWindowId }),
    onFileAccessed: overrides.onFileAccessed,
  })
  return { session, editor: editor.value, recoveryWrites, fileWrites, errors, treeResults, invocations, diskFiles }
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
    ask: async () => { asks += 1; return false },
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
      ask: async () => false,
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

test('文書の破棄確認を取り消すと本文・保存先・未保存状態と復元候補を維持する', async () => {
  const { session, editor, recoveryWrites } = createDocumentHarness({ ask: async () => false })
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
      if (command === 'project_file_authorize') return expectedPath
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
      ask: async () => { askCount += 1; return true },
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

test('検索候補の破棄確認取消では本文・保存先・出自・復元候補を保つ', async () => {
  const { session, editor, request, treeResults, recoveryWrites } = createQuickOpenHarness({ ask: async () => false })
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
    ask: async () => { askCount += 1; return true },
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
