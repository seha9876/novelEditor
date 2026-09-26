/** 文書ファイルと復元候補の保存順序を検証する。 */
import {
  assert,
  deferred,
  loadRecoveryModule,
  loadSourceModule,
  test,
  TextDecoder,
  TextEncoder,
} from './test-support.mjs'

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
