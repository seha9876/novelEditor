/** ディスク比較と外部更新監視のタイミング・寿命を検証する。 */
import { assert, deferred, loadSourceModule, test } from './test-support.mjs'

test('外部状態は内容を比較し、BOM・改行の違いと欠落・読取失敗を区別する', async () => {
  const calls = []
  const api = loadSourceModule('src/externalFile.ts', { '@tauri-apps/api/core': { invoke: async (command, args) => {
    calls.push({ command, args })
    if (command === 'text_file_inspect') throw new Error('読取不可')
    return { kind: 'conflict', disk: { kind: 'missing' } }
  } } })
  const baseline = new Uint8Array([65, 10])
  assert.equal(api.classifyExternalFile({ kind: 'present', bytes: [65, 10] }, baseline), 'unchanged')
  assert.equal(api.classifyExternalFile({ kind: 'present', bytes: [65, 13, 10] }, baseline), 'changed')
  assert.equal(api.classifyExternalFile({ kind: 'present', bytes: [239, 187, 191, 65, 10] }, baseline), 'changed')
  assert.equal(api.classifyExternalFile({ kind: 'present', bytes: [66, 10] }, baseline), 'changed')
  assert.equal(api.classifyExternalFile({ kind: 'missing' }, baseline), 'missing')
  assert.equal(api.classifyExternalFile({ kind: 'error', message: '読取不可' }, baseline), 'error')
  assert.deepEqual(await api.inspectTextFile('C:/原稿.txt'), { kind: 'error', message: 'Error: 読取不可' })
  const expected = { kind: 'present', bytes: [65, 10] }
  assert.equal((await api.writeTextFileConditional('C:/原稿.txt', expected, baseline)).kind, 'conflict')
  assert.deepEqual(calls[1].args, { path: 'C:/原稿.txt', expected, bytes: [65, 10] })
})

test('前面では5秒間隔と復帰直後に確認し、背面と破棄後では確認しない', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { useExternalFileMonitor } = loadSourceModule('src/useExternalFileMonitor.ts')
  let focus
  let calls = 0
  let unsubscribed = 0
  const monitor = useExternalFileMonitor({ appWindow: {
    onFocusChanged: async (callback) => { focus = callback; return () => { unsubscribed += 1 } },
    isFocused: async () => true,
  }, check: async () => { calls += 1 }, onError: assert.fail })
  await monitor.setup()
  await monitor.setup()
  assert.equal(calls, 1)
  t.mock.timers.tick(4999)
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  assert.equal(calls, 2)
  focus({ payload: false })
  t.mock.timers.tick(15000)
  assert.equal(calls, 2)
  focus({ payload: true })
  assert.equal(calls, 3)
  monitor.dispose()
  t.mock.timers.tick(10000)
  focus({ payload: true })
  assert.equal(calls, 3)
  assert.equal(unsubscribed, 1)
})

test('購読待ちの破棄と古い初期フォーカス応答を捨て、開始失敗時も購読を残さない', async () => {
  const { useExternalFileMonitor } = loadSourceModule('src/useExternalFileMonitor.ts')
  const subscription = deferred()
  let released = 0
  const monitor = useExternalFileMonitor({ appWindow: {
    onFocusChanged: () => subscription.promise, isFocused: async () => { assert.fail('破棄後に初期化しない') },
  }, check: async () => { assert.fail('破棄後に確認しない') }, onError: assert.fail })
  const setup = monitor.setup()
  monitor.dispose()
  subscription.release(() => { released += 1 })
  await setup
  assert.equal(released, 1)

  const initial = deferred()
  let focus
  let calls = 0
  const active = useExternalFileMonitor({ appWindow: {
    onFocusChanged: async (callback) => { focus = callback; return () => {} },
    isFocused: () => initial.promise,
  }, check: async () => { calls += 1 }, onError: assert.fail })
  const starting = active.setup()
  await Promise.resolve()
  focus({ payload: false })
  initial.release(true)
  await starting
  assert.equal(calls, 0)
  active.dispose()
  const errors = []
  const failed = useExternalFileMonitor({ appWindow: {
    onFocusChanged: async () => () => { released += 1 },
    isFocused: async () => { throw new Error('取得失敗') },
  }, check: async () => {}, onError: (error) => errors.push(error) })
  await failed.setup()
  failed.dispose()
  assert.equal(released, 2)
  assert.equal(errors.length, 1)
})
