/** 最近開いたファイルの非同期操作、キーボード選択、履歴だけの削除を検証する。 */
import { assert, deferred, loadSourceModule, require, test } from './test-support.mjs'

/** 実際のVue状態を使い、永続化と文書読込の境界だけを制御する。 */
function createHarness(overrides = {}) {
  const calls = []
  const entries = [{ id: 1, path: 'C:/作品一/原稿.txt' }, { id: 2, path: 'D:/作品二/原稿.txt' }]
  const { ref } = require('vue')
  const disabled = ref(false)
  const { useRecentFilesController } = loadSourceModule('src/useRecentFilesController.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      calls.push({ command, args })
      return overrides.invoke ? overrides.invoke(command, args) : entries
    } },
    '@tauri-apps/plugin-dialog': { ask: overrides.ask ?? (async () => true) },
  })
  const controller = useRecentFilesController({ disabled, openFile: overrides.openFile ?? (async () => true) })
  return { controller, disabled, calls, entries }
}

test('履歴は毎回取得し、同名原稿をパスとIDで区別して上下移動・決定する', async () => {
  const opened = []
  const { controller: c, calls } = createHarness({ openFile: async (file) => { opened.push(file); return true } })
  await c.open()
  assert.equal(c.selectedId.value, 1)
  c.moveSelection(-1)
  assert.equal(c.selectedId.value, 1)
  c.moveSelection(1)
  c.moveSelection(1)
  assert.equal(c.selectedId.value, 2)
  await c.openSelected(999)
  assert.equal(opened.length, 0)
  await c.openSelected(2)
  assert.equal(opened[0].path, 'D:/作品二/原稿.txt')
  assert.equal(c.isOpen.value, false)
  await c.open()
  assert.equal(c.selectedId.value, 1)
  assert.equal(calls.length, 2)
  c.dispose()
})

test('取消・欠落ファイルの失敗では一覧と順序を維持し、理由を表示して再試行できる', async () => {
  let fail = false
  const { controller: c, entries } = createHarness({ openFile: async () => {
    if (fail) throw new Error('ファイルがありません')
    return false
  } })
  await c.open()
  await c.openSelected(2)
  assert.equal(c.isOpen.value, true)
  assert.equal(c.error.value, '')
  fail = true
  await c.openSelected(2)
  assert.match(c.error.value, /ファイルがありません/)
  assert.deepEqual(c.entries.value, entries)
  assert.equal(c.pending.value, false)
  c.close()
  await c.open()
  assert.equal(c.error.value, '')
  c.dispose()
})

test('個別削除は隣の項目を選び、全消去は確認の取消・失敗で履歴を保持する', async () => {
  let confirmed = false
  let fail = false
  const { controller: c, calls, entries } = createHarness({ ask: async () => confirmed,
    invoke: async (command) => {
      if (command === 'recent_files_list') return entries
      if (fail) throw new Error('DB保存失敗')
    },
  })
  await c.open()
  await c.remove(null)
  assert.equal(calls.length, 1)
  fail = true
  await c.remove(1)
  assert.deepEqual(c.entries.value, entries)
  assert.match(c.error.value, /DB保存失敗/)
  fail = false
  await c.remove(1)
  assert.equal(c.selectedId.value, 2)
  assert.deepEqual(c.entries.value.map((item) => item.id), [2])
  confirmed = true
  await c.remove(null)
  assert.deepEqual(c.entries.value, [])
  assert.equal(c.selectedId.value, null)
  assert.deepEqual(calls.map((call) => call.command), ['recent_files_list', 'recent_files_remove', 'recent_files_remove', 'recent_files_clear'])
  c.dispose()
})

test('履歴読込と決定中は二重操作せず、破棄後の遅着結果も反映しない', async () => {
  const gate = deferred()
  const opened = deferred()
  let openCount = 0
  const { controller: c, calls, disabled, entries } = createHarness({
    invoke: () => gate.promise,
    openFile: () => { openCount += 1; return opened.promise },
  })
  disabled.value = true
  await c.open()
  assert.equal(c.isOpen.value, false)
  disabled.value = false
  const loading = c.open()
  await c.open()
  await c.remove(null)
  c.close()
  assert.equal(calls.length, 1)
  assert.equal(c.isOpen.value, true)
  gate.release(entries)
  await loading
  const opening = c.openSelected(1)
  await c.openSelected(2)
  await c.remove(1)
  c.moveSelection(1)
  assert.equal(openCount, 1)
  assert.equal(c.selectedId.value, 1)
  c.dispose()
  opened.release(true)
  await opening
  await c.open()
  assert.equal(c.isOpen.value, false)
  assert.equal(c.pending.value, false)
})

test('全消去の保存失敗と確認待ちの破棄では一覧を変えず、遅着確認で削除しない', async () => {
  const { controller: c, entries } = createHarness({ invoke: async (command) => {
    if (command === 'recent_files_list') return entries
    throw new Error('全消去失敗')
  } })
  await c.open()
  await c.remove(null)
  assert.deepEqual(c.entries.value, entries)
  assert.match(c.error.value, /全消去失敗/)
  c.dispose()
  const confirmation = deferred()
  const { controller: late, calls } = createHarness({ ask: () => confirmation.promise })
  await late.open()
  const clearing = late.remove(null)
  late.dispose()
  confirmation.release(true)
  await clearing
  assert.equal(calls.length, 1)
})

test('一覧の取得失敗と破棄後の取得成功・失敗を安全に処理する', async () => {
  const { controller: c } = createHarness({ invoke: async () => { throw new Error('読込不可') } })
  await c.open()
  assert.match(c.error.value, /読込不可/)
  assert.equal(c.pending.value, false)
  c.dispose()
  for (const reject of [false, true]) {
    const gate = deferred()
    const { controller: late } = createHarness({ invoke: async () => {
      const value = await gate.promise
      if (reject) throw new Error('遅着')
      return value
    } })
    const loading = late.open()
    late.dispose()
    gate.release([{ id: 3, path: 'C:/遅着.txt' }])
    await loading
    assert.deepEqual(late.entries.value, [])
    assert.equal(late.error.value, '')
  }
})

test('通常・拡張・UNCパスを同一視し、異なる保存場所を区別する', () => {
  const { sameRecentFilePath } = loadSourceModule('src/recentFiles.ts', { '@tauri-apps/api/core': { invoke() {} } })
  assert.ok(sameRecentFilePath('C:/原稿/ABC.txt', String.raw`\\?\C:\原稿\abc.txt`))
  assert.ok(sameRecentFilePath(String.raw`\\server\share\原稿.txt`, String.raw`\\?\UNC\SERVER\share\原稿.txt`))
  assert.equal(sameRecentFilePath('C:/原稿.txt', 'D:/原稿.txt'), false)
})

test('履歴コマンドはツールバーに追加でき、既定のショートカットを持たない', () => {
  const { getToolbarCommandDefinitions } = loadSourceModule('src/appCommands.ts')
  const command = getToolbarCommandDefinitions().find((entry) => entry.id === 'document.recentFiles')
  assert.ok(command)
  assert.equal(command.shortcut, undefined)
})
