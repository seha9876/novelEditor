/** メイン画面の初期化とメイン窓Controllerを検証する。 */
import {
  assert,
  deferred,
  loadSourceModule,
  readFileSync,
  projectRoot,
  require,
  resolve,
  test,
} from './test-support.mjs'

test('メイン画面の初期化は破棄後に遅着awaitを継続しない', () => {
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  assert.match(app, /let appLifecycleGeneration = 0/)
  assert.match(app, /function isAppLifecycleActive\(generation: number\)/)
  assert.match(app, /await setupMainWindowController\(\)\s*if \(!isAppLifecycleActive\(generation\)\) return/)
  assert.match(app, /appMounted = false\s*appLifecycleGeneration \+= 1\s*window\.removeEventListener/)
})

test('メイン窓Controllerは低レベル終了要求を一度だけ調停へ渡し、表示状態を解除する', async () => {
  const { ref } = require('vue')
  let closeHandler
  let resizeHandler
  let closeUnlistenCount = 0
  let resizeUnlistenCount = 0
  const appWindow = {
    async isMaximized() { return true },
    async isAlwaysOnTop() { return false },
    async onCloseRequested(handler) { closeHandler = handler; return () => { closeUnlistenCount += 1 } },
    async onResized(handler) { resizeHandler = handler; return () => { resizeUnlistenCount += 1 } },
    async close() {},
  }
  const windowApi = {
    getCurrentWindow: () => appWindow,
    currentMonitor: async () => null,
    PhysicalPosition: class {},
    PhysicalSize: class {},
  }
  const controllerModule = loadSourceModule('src/useMainWindowController.ts', {
    '@tauri-apps/api/window': windowApi,
  })
  const closeInProgress = ref(false)
  let closeRequests = 0
  const controller = controllerModule.useMainWindowController({
    mainCloseInProgress: closeInProgress,
    showError: async () => {},
    onCloseRequested: async () => { closeRequests += 1 },
  })

  await controller.setup()
  assert.equal(controller.maximized.value, true)
  assert.equal(controller.alwaysOnTop.value, false)
  let prevented = 0
  await closeHandler({ preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1)
  assert.equal(closeRequests, 1)
  closeInProgress.value = true
  await closeHandler({ preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 2)
  assert.equal(closeRequests, 1)
  resizeHandler()
  controller.dispose()
  assert.equal(closeUnlistenCount, 1)
  assert.equal(resizeUnlistenCount, 1)
})

test('メイン窓Controllerは購読待ちの破棄後に遅着unlistenを解除し、追加購読を作らない', async () => {
  const closeListenDeferred = deferred()
  let closeListenCount = 0
  let resizeListenCount = 0
  let closeUnlistenCount = 0
  const appWindow = {
    async isMaximized() { return false },
    async isAlwaysOnTop() { return false },
    async onCloseRequested() {
      closeListenCount += 1
      return closeListenDeferred.promise
    },
    async onResized() {
      resizeListenCount += 1
      return () => {}
    },
  }
  const controllerModule = loadSourceModule('src/useMainWindowController.ts', {
    '@tauri-apps/api/window': {
      getCurrentWindow: () => appWindow,
      currentMonitor: async () => null,
      PhysicalPosition: class {},
      PhysicalSize: class {},
    },
  })
  const controller = controllerModule.useMainWindowController({
    appWindow,
    mainCloseInProgress: { value: false },
    showError: async () => {},
    onCloseRequested: async () => {},
  })

  const firstSetup = controller.setup()
  const secondSetup = controller.setup()
  controller.dispose()
  closeListenDeferred.release(() => { closeUnlistenCount += 1 })
  await Promise.all([firstSetup, secondSetup])
  assert.equal(closeListenCount, 1)
  assert.equal(closeUnlistenCount, 1)
  assert.equal(resizeListenCount, 0)
})
