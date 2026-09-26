/** 保存先、文書ファイル、復元候補の保存順序と破損時の復旧を検証する。 */
import {
  assert,
  deferred,
  loadRecoveryModule,
  loadSourceModule,
  readFileSync,
  projectRoot,
  resolve,
  test,
  TextDecoder,
  TextEncoder,
  ts,
} from './test-support.mjs'

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
