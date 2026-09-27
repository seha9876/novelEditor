/** 分離プロジェクトツリーの子窓ライフサイクルを検証する。 */
import {
  assert,
  deferred,
  loadSourceModule,
  require,
  test,
} from './test-support.mjs'

test('分離ツリーControllerは購読待ちの破棄後に遅着unlistenを解除する', async () => {
  const listenDeferred = deferred()
  let unlistenCount = 0
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const { ref } = require('vue')
    const controllerModule = loadSourceModule('src/useProjectTreeWindowController.ts', {
      './appPreferences': { saveProjectTreePreferences: async () => {} },
      '@tauri-apps/api/event': {
        async emitTo() {},
        async listen() { return listenDeferred.promise },
      },
      '@tauri-apps/api/webviewWindow': {
        WebviewWindow: class {},
      },
    })
    const controller = controllerModule.useProjectTreeWindowController({
      initialPreferences: { ui: { projectTree: { width: 280, detached: false } } },
      busy: ref(false),
      documentLocked: ref(false),
      documentOrigin: ref(null),
      mainCloseInProgress: ref(false),
      showPersistenceNotice: () => {},
      showError: async () => {},
      openProjectTreeFile: async () => {},
      onOriginDetached: () => {},
    })

    const setup = controller.setup()
    await controller.dispose()
    listenDeferred.release(() => { unlistenCount += 1 })
    await setup
    assert.equal(unlistenCount, 1)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('分離ツリー生成の破棄後イベントは状態保存や通知を行わず失敗で完了する', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const { ref } = require('vue')
    const callbacks = {}
    let destroyCount = 0
    const notices = []
    const savedPreferences = []
    class MockWebviewWindow {
      constructor() {}
      once(event, callback) {
        callbacks[event] = callback
        return Promise.resolve(() => {})
      }
      destroy() {
        destroyCount += 1
        return Promise.resolve()
      }
    }
    const controllerModule = loadSourceModule('src/useProjectTreeWindowController.ts', {
      './appPreferences': {
        saveProjectTreePreferences: async (preferences) => { savedPreferences.push(preferences) },
      },
      '@tauri-apps/api/event': {
        async emitTo() {},
        async listen() { return () => {} },
      },
      '@tauri-apps/api/webviewWindow': { WebviewWindow: MockWebviewWindow },
    })
    const controller = controllerModule.useProjectTreeWindowController({
      initialPreferences: { ui: { projectTree: { width: 280, detached: false } } },
      busy: ref(false),
      documentLocked: ref(false),
      documentOrigin: ref(null),
      mainCloseInProgress: ref(false),
      showPersistenceNotice: (notice) => { notices.push(notice) },
      showError: async () => {},
      openProjectTreeFile: async () => {},
      onOriginDetached: () => {},
    })

    const opening = controller.openProjectTreeWindow()
    await controller.dispose()
    callbacks['tauri://created']()
    assert.equal(await opening, false)
    assert.equal(destroyCount, 1)
    assert.deepEqual(notices, [])
    assert.deepEqual(savedPreferences, [])
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

/** 分離ツリーの生成・破棄イベントを手動で進め、実際のController lifecycleを検証する。 */
function createProjectTreeWindowHarness(destroyImplementation = () => Promise.resolve()) {
  const { ref } = require('vue')
  const callbacks = {}
  const emittedStates = []
  const notices = []
  const savedPreferences = []
  let commandHandler
  let constructorCount = 0
  let destroyCount = 0
  class MockWebviewWindow {
    constructor() {
      constructorCount += 1
    }
    once(event, callback) {
      callbacks[event] = callback
      return Promise.resolve(() => {})
    }
    destroy() {
      destroyCount += 1
      return destroyImplementation()
    }
  }
  const controllerModule = loadSourceModule('src/useProjectTreeWindowController.ts', {
    './appPreferences': {
      saveProjectTreePreferences: async (preferences) => { savedPreferences.push(preferences) },
    },
    '@tauri-apps/api/event': {
      async emitTo(_label, _event, state) { emittedStates.push(state) },
      async listen(_event, handler) { commandHandler = handler; return () => {} },
    },
    '@tauri-apps/api/webviewWindow': { WebviewWindow: MockWebviewWindow },
  }, new Map())
  const controller = controllerModule.useProjectTreeWindowController({
    initialPreferences: { ui: { projectTree: { width: 280, detached: false } } },
    busy: ref(false),
    documentLocked: ref(false),
    documentOrigin: ref(null),
    mainCloseInProgress: ref(false),
    showPersistenceNotice: (notice) => { notices.push(notice) },
    showError: async () => {},
    openProjectTreeFile: async () => {},
    onOriginDetached: () => {},
  })
  return {
    controller,
    callbacks,
    emittedStates,
    notices,
    savedPreferences,
    get commandHandler() { return commandHandler },
    get constructorCount() { return constructorCount },
    get destroyCount() { return destroyCount },
  }
}

test('分離ツリーはcreated/errorなしのdestroyedだけでも生成Promiseを失敗で完了する', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const harness = createProjectTreeWindowHarness()
    const opening = harness.controller.openProjectTreeWindow()
    harness.callbacks['tauri://destroyed']()
    assert.equal(await opening, false)
    assert.equal(harness.destroyCount, 0)
    assert.deepEqual(harness.notices, [])
    await harness.controller.dispose()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('分離ツリーのerror後にdestroyedが遅着しても生成Promiseを一度だけ失敗で完了する', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const harness = createProjectTreeWindowHarness()
    const opening = harness.controller.openProjectTreeWindow()
    harness.callbacks['tauri://error']({ payload: '生成失敗' })
    harness.callbacks['tauri://destroyed']()
    assert.equal(await opening, false)
    assert.equal(harness.destroyCount, 0)
    assert.equal(harness.notices.length, 1)
    await harness.controller.dispose()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('分離ツリーのdockとdisposeが競合してもdestroyを一度だけ共有する', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const destroyDeferred = deferred()
    const harness = createProjectTreeWindowHarness(() => destroyDeferred.promise)
    await harness.controller.setup()
    const opening = harness.controller.openProjectTreeWindow()
    harness.callbacks['tauri://created']()
    assert.equal(await opening, true)
    const windowId = harness.emittedStates.at(-1).windowId
    harness.commandHandler({ payload: { type: 'dock', windowId } })
    await Promise.resolve()
    const disposing = harness.controller.dispose()
    destroyDeferred.release()
    await disposing
    await Promise.resolve()
    assert.equal(harness.destroyCount, 1)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('分離ツリーのclose待ち中にdisposeしても破棄後の再生成を行わない', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const destroyDeferred = deferred()
    const harness = createProjectTreeWindowHarness(() => destroyDeferred.promise)
    await harness.controller.setup()
    const opening = harness.controller.openProjectTreeWindow()
    harness.callbacks['tauri://created']()
    assert.equal(await opening, true)
    const windowId = harness.emittedStates.at(-1).windowId
    harness.commandHandler({ payload: { type: 'dock', windowId } })
    await Promise.resolve()
    const reopening = harness.controller.openProjectTreeWindow()
    const disposing = harness.controller.dispose()
    destroyDeferred.release()
    assert.equal(await reopening, false)
    await disposing
    await Promise.resolve()
    assert.equal(harness.constructorCount, 1)
    assert.equal(harness.destroyCount, 1)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('分離ツリーの終了用closeとdisposeが競合してもdestroyを一度だけ共有する', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const destroyDeferred = deferred()
    const harness = createProjectTreeWindowHarness(() => destroyDeferred.promise)
    const opening = harness.controller.openProjectTreeWindow()
    harness.callbacks['tauri://created']()
    assert.equal(await opening, true)
    const closing = harness.controller.closeProjectTreeWindowForExit()
    const disposing = harness.controller.dispose()
    destroyDeferred.release()
    await Promise.all([closing, disposing])
    assert.equal(harness.destroyCount, 1)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
