/** Git の通信境界を模擬し、確認・保存連携・取消・非同期競合を検証する。 */
import { assert, deferred, loadSourceModule, require, test, readFileSync, resolve, projectRoot } from './test-support.mjs'

/** UIの状態と通常保存を実際のControllerへ接続する。原稿やGitは変更しない。 */
function harness(overrides = {}) {
  const { ref } = require('vue')
  const calls = []
  const isOpen = ref(false), disabled = ref(false), path = ref('C:/作品/原稿.txt'), dirty = ref(false)
  const state = { branch: 'main', head: 'a'.repeat(40), changes: [{ path: '原稿.txt', kind: 'modified' }], token: 'confirmed', blocked: null, authorName: '作者', authorEmail: 'writer@localhost', backupState: '未設定' }
  const workspaces = [{ id: 1, root: 'C:/作品', backup: 'D:/backup.git', authorName: '', authorEmail: '' }]
  let saves = 0
  const { useGitHistoryController } = loadSourceModule('src/useGitHistoryController.ts', {
    '@tauri-apps/plugin-dialog': { ask: overrides.ask ?? (async () => true), open: overrides.choose ?? (async () => null), save: overrides.save ?? (async () => null) },
    '@tauri-apps/api/core': { invoke: async (command, { request }) => {
      assert.equal(command, 'git_history'); calls.push(request)
      if (overrides.invoke) { const result = await overrides.invoke(request); if (result !== undefined) return result }
      if (request.kind === 'list') return { version: 'git version test', error: null, workspaces }
      if (request.kind === 'status') return JSON.parse(JSON.stringify(state))
      if (request.kind === 'history') return []
      if (request.kind === 'files') return ['原稿.txt']
      if (request.kind === 'blob') return [0xef, 0xbb, 0xbf, 65, 13, 10]
      if (request.kind === 'branches') return ['main', 'draft']
      if (request.kind === 'inspect') return 'C:/作品'
      return null
    } },
  })
  const c = useGitHistoryController({ isOpen, disabled, path, dirty, saveDocument: async () => { saves++; if (overrides.saveDocument) await overrides.saveDocument(); else dirty.value = false } })
  return { c, calls, isOpen, disabled, path, dirty, state, workspaces, saves: () => saves }
}

test('Gitの一覧と状態を取得し、TXTの選択・説明・確認指紋を記録へ渡す', async () => {
  const h = harness(); await h.c.open()
  assert.equal(h.c.selectedId.value, 1)
  assert.deepEqual(h.c.selectedPaths.value, ['原稿.txt'])
  h.c.description.value = '会話の推敲'; await h.c.beginRecord()
  const request = h.calls.find(r => r.kind === 'record')
  assert.equal(request.message, '会話の推敲'); assert.equal(request.token, 'confirmed')
  assert.deepEqual(request.paths, ['原稿.txt']); assert.match(h.c.notice.value, /記録しました/)
})

test('未保存確認の取消は記録せず、保存済み内容だけなら通常保存を呼ばない', async () => {
  const h = harness(); await h.c.open(); h.dirty.value = true
  await h.c.beginRecord(); assert.equal(h.c.savePrompt.value, true)
  await h.c.record('cancel'); assert.equal(h.calls.some(r => r.kind === 'record'), false)
  await h.c.beginRecord(); await h.c.record('disk')
  assert.equal(h.saves(), 0); assert.equal(h.dirty.value, true)
  assert.match(h.calls.find(r => r.kind === 'record').message, /^原稿の記録 /)
})

test('保存して続ける操作は競合や取消なら記録せず、成功後も一覧の再確認を挟む', async () => {
  let succeeded = false
  const h = harness({ saveDocument: async () => { if (succeeded) h.dirty.value = false } })
  await h.c.open(); h.dirty.value = true; await h.c.beginRecord(); await h.c.record('save')
  assert.match(h.c.error.value, /保存が完了していない/)
  assert.equal(h.calls.some(r => r.kind === 'record'), false)
  succeeded = true; await h.c.beginRecord(); await h.c.record('save')
  assert.match(h.c.notice.value, /もう一度/); assert.equal(h.calls.some(r => r.kind === 'record'), false)
  await h.c.beginRecord(); assert.equal(h.calls.filter(r => r.kind === 'record').length, 1)
})

test('別フォルダーの未保存原稿には保存確認を出さず、既存ステージ中は記録を止める', async () => {
  const h = harness(); h.state.blocked = 'コミット準備中'; await h.c.open()
  await h.c.beginRecord(); assert.equal(h.calls.some(r => r.kind === 'record'), false)
  h.state.blocked = null; await h.c.refresh(); h.dirty.value = true; h.path.value = 'C:/作品別/原稿.txt'
  await h.c.beginRecord(); assert.equal(h.c.savePrompt.value, false); assert.equal(h.saves(), 0)
})

test('処理中の連打と画面終了を抑止し、破棄後の遅着結果は反映しない', async () => {
  const waiting = deferred()
  const h = harness({ invoke: async r => { if (r.kind === 'record') return waiting.promise } })
  await h.c.open(); const recording = h.c.beginRecord()
  await h.c.beginRecord(); h.c.close()
  assert.equal(h.calls.filter(r => r.kind === 'record').length, 1); assert.equal(h.isOpen.value, true)
  h.c.dispose(); waiting.release('new-id'); await recording
  assert.equal(h.c.notice.value, ''); assert.equal(h.calls.filter(r => r.kind === 'list').length, 1)
})

test('Git記録失敗時は最新状態へ戻し、元の失敗理由を維持する', async () => {
  const h = harness({ invoke: async r => { if (r.kind === 'record') throw new Error('外部変更がありました') } })
  await h.c.open(); await h.c.beginRecord()
  assert.match(h.c.error.value, /外部変更/); assert.equal(h.c.pending.value, false)
  assert.equal(h.calls.filter(r => r.kind === 'status').length, 2)
})

test('履歴のページ送り、本文プレビュー、UTF-8エラー、取り出し取消を扱う', async () => {
  let invalid = false
  const h = harness({ invoke: async r => {
    if (r.kind === 'history') return r.offset ? [] : Array.from({ length: 50 }, (_, n) => ({ id: String(n), date: '', message: '', author: '' }))
    if (r.kind === 'blob' && invalid) return [255]
  } })
  await h.c.open(); assert.equal(h.c.hasMore.value, true); await h.c.more()
  assert.equal(h.c.hasMore.value, false); assert.equal(h.c.entries.value.length, 50)
  await h.c.selectCommit('first'); await h.c.selectFile('原稿.txt'); assert.equal(h.c.preview.value, 'A\r\n')
  invalid = true; await h.c.selectFile('原稿.txt'); assert.match(h.c.previewError.value, /UTF-8/)
  await h.c.exportFile(); assert.equal(h.calls.some(r => r.kind === 'export'), false)
})

test('取り出し・バックアップの失敗は原稿保存を呼ばず理由を示す', async () => {
  const h = harness({ save: async () => 'D:/existing.txt', invoke: async r => {
    if (r.kind === 'export') throw new Error('既存ファイルは上書きしません')
    if (r.kind === 'backup') throw new Error('ドライブ未接続')
  } })
  await h.c.open(); await h.c.selectCommit('first'); await h.c.selectFile('原稿.txt'); await h.c.exportFile()
  assert.match(h.c.error.value, /上書きしません/)
  await h.c.backup(); assert.match(h.c.error.value, /未接続/); assert.equal(h.saves(), 0)
  assert.equal(h.calls.filter(r => r.kind === 'status').length, 2)
})

test('Gitが未導入でも登録一覧を保持し、原稿の保存や本文に操作しない', async () => {
  const h = harness({ invoke: async r => {
    if (r.kind === 'list') return { workspaces: [], version: null, error: 'Git for Windows をインストールしてください' }
  } })
  await h.c.open()
  assert.equal(h.c.version.value, null); assert.equal(h.c.status.value, null)
  assert.match(h.c.error.value, /Git for Windows/); assert.equal(h.saves(), 0)
  h.c.close(); assert.equal(h.isOpen.value, false)
})

test('登録とバックアップ先の確認を取り消すとGitへ変更を依頼しない', async () => {
  const h = harness({ choose: async () => 'C:/selected', ask: async () => false })
  await h.c.open(); await h.c.add(); await h.c.setBackup(); await h.c.remove()
  assert.equal(h.calls.some(r => ['register', 'setBackup', 'remove'].includes(r.kind)), false)
})

test('復元はブランチと新規フォルダーを渡し、成功後に一覧を更新する', async () => {
  const h = harness({ choose: async () => 'D:/selected' })
  await h.c.open(); await h.c.beginRestore(); assert.equal(h.c.restoreBranch.value, 'main')
  h.c.restoreName.value = '原稿を復元'; await h.c.restore()
  const request = h.calls.find(r => r.kind === 'restore')
  assert.equal(request.name, '原稿を復元'); assert.equal(request.branch, 'main'); assert.equal(h.c.restoreSource.value, '')
})

test('Windowsの所属判定は拡張長パスを扱い、似た名前の隣接フォルダーを除外する', () => {
  const { isInsideGitWorkspace } = loadSourceModule('src/gitHistory.ts', { '@tauri-apps/api/core': {} })
  assert.equal(isInsideGitWorkspace('\\\\?\\C:\\作品\\原稿.txt', 'c:/作品'), true)
  assert.equal(isInsideGitWorkspace('C:/作品別/a.txt', 'C:/作品'), false)
  assert.equal(isInsideGitWorkspace(null, 'C:/作品'), false)
})

test('終了経路はGit完了待ちを案内し、履歴画面中は本文と分離検索を操作禁止にする', () => {
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  assert.match(app, /if \(gitHistory\.pending\.value\)[\s\S]*?完了してからもう一度終了/)
  assert.match(app, /:read-only="editorInteractionLocked"/)
  assert.match(app, /fileNavigationBlocked: gitHistoryOpen/)
})
