/** 本文セッションの状態と復旧await中の破棄を検証する。 */
import {
  assert,
  deferred,
  loadSourceModule,
  require,
  test,
} from './test-support.mjs'

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
