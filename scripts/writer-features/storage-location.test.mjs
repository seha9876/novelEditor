/** 保存先確定、保存先起動画面、復元Storeの読み込み境界を検証する。 */
import {
  assert,
  loadRecoveryModule,
  loadSourceModule,
  readFileSync,
  projectRoot,
  resolve,
  test,
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
  const styles = readFileSync(resolve(projectRoot, 'src/styles/statistics.css'), 'utf8')
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
