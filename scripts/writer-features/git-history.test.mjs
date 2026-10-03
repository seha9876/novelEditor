/** Git の通信境界を模擬し、確認・保存連携・取消・非同期競合を検証する。 */
import { assert, deferred, loadSourceModule, require, test, readFileSync, resolve, projectRoot } from './test-support.mjs'

/** UIの状態と通常保存を実際のControllerへ接続する。原稿やGitは変更しない。 */
function harness(overrides = {}) {
  const { ref } = require('vue')
  const calls = []
  const isOpen = ref(false), disabled = ref(false), path = ref('C:/作品/原稿.txt'), dirty = ref(false)
  const externalState = ref('unchanged'), externalError = ref('')
  const state = { branch: 'main', head: 'a'.repeat(40), changes: [{ path: '原稿.txt', kind: 'modified' }], token: 'confirmed', blocked: null, authorName: '作者', authorEmail: 'writer@localhost', backupState: 'notSet' }
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
      if (request.kind === 'branches') return [{ name: 'main', id: 'a'.repeat(40), date: '2026-10-03T10:00:00+09:00', message: '初稿' }, { name: 'draft', id: 'b'.repeat(40), date: '2026-10-02T10:00:00+09:00', message: '推敲前' }]
      if (request.kind === 'inspect') return 'C:/作品'
      return null
    } },
  })
  const c = useGitHistoryController({ isOpen, disabled, path, dirty, externalState, externalError, saveDocument: async () => { saves++; if (overrides.saveDocument) await overrides.saveDocument(); else dirty.value = false } })
  return { c, calls, isOpen, disabled, path, dirty, externalState, externalError, state, workspaces, saves: () => saves }
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
  const h = harness(); h.state.blocked = 'stagedOrConflict'; await h.c.open()
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

test('復元は複数候補を自動選択せず、出力先を確認した明示操作でのみ実行する', async () => {
  const h = harness({ choose: async () => 'D:/selected' })
  await h.c.open(); await h.c.beginRestore(); assert.equal(h.c.restoreBranch.value, '')
  await h.c.restore(); assert.equal(h.calls.some(r => r.kind === 'restore'), false)
  h.c.restoreBranch.value = 'main'; h.c.restoreName.value = '原稿を復元'; await h.c.chooseRestoreParent()
  assert.equal(h.calls.some(r => r.kind === 'restore'), false); assert.equal(h.c.restoreDestination.value, 'D:/selected/原稿を復元')
  await h.c.restore()
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
  assert.match(app, /if \(gitHistory\.pending\.value \|\| sidebarHistory\.pending\.value \|\| sidebarHistory\.exporting\.value\)[\s\S]*?完了してからもう一度終了/)
  assert.match(app, /:read-only="editorInteractionLocked"/)
  assert.match(app, /fileNavigationBlocked: gitHistoryOpen/)
})


test('初期確認・Git未利用・登録取得失敗を区別し、未確認の状態で記録しない', async () => {
  const waiting = deferred()
  const h = harness({ invoke: async r => { if (r.kind === 'list') return waiting.promise } })
  const opening = h.c.open(); assert.equal(h.c.listReady.value, false); assert.equal(h.c.pendingLabel.value, '状態を確認中')
  assert.equal(h.c.status.value, null); await h.c.beginRecord(); assert.equal(h.calls.some(r => r.kind === 'record'), false)
  waiting.release({ version: null, error: '未導入', workspaces: h.workspaces }); await opening
  assert.equal(h.c.listReady.value, true); assert.equal(h.c.listFailed.value, false); assert.equal(h.c.workspace.value.id, 1)
  const failed = harness({ invoke: async r => { if (r.kind === 'list') throw new Error('DBを読めません') } })
  await failed.c.open(); assert.equal(failed.c.listFailed.value, true); assert.equal(failed.c.listReady.value, false)
  assert.ok(failed.c.recordDisabledReason.value); assert.ok(failed.c.backupDisabledReason.value)
})

test('対象外の本文を保存済みと扱わず、型付きの制限理由で記録を止める', async () => {
  const h = harness(); await h.c.open(); h.path.value = null; h.dirty.value = true
  assert.equal(h.c.currentInside.value, false); assert.equal(h.c.unsaved.value, false)
  h.path.value = 'C:/作品/原稿.txt'; assert.equal(h.c.unsaved.value, true)
  for (const block of ['detached', 'busy', 'stagedOrConflict']) {
    h.state.blocked = block; await h.c.refresh(); assert.ok(h.c.recordDisabledReason.value)
    await h.c.beginRecord(); assert.equal(h.calls.some(r => r.kind === 'record'), false)
  }
})

test('タブ切替は通信せず、再確認でメモ・名前・有効な選択を保持する', async () => {
  const h = harness(); h.state.changes.push({ path: '別章.txt', kind: 'added' }); await h.c.open()
  h.c.description.value = '推敲'; h.c.authorName.value = 'ペンネーム'; h.c.authorEmail.value = 'local@example.test'
  h.c.selectedPaths.value = ['別章.txt']; const count = h.calls.length
  for (const tab of ['history', 'backup', 'record']) h.c.showTab(tab)
  assert.equal(h.calls.length, count); assert.deepEqual(h.c.selectedPaths.value, ['別章.txt'])
  await h.c.refresh(); assert.equal(h.c.description.value, '推敲'); assert.equal(h.c.authorName.value, 'ペンネーム')
  assert.equal(h.c.authorEmail.value, 'local@example.test'); assert.deepEqual(h.c.selectedPaths.value, ['別章.txt'])
  h.state.changes = [{ path: '原稿.txt', kind: 'modified' }]; await h.c.refresh()
  assert.deepEqual(h.c.selectedPaths.value, []); assert.match(h.c.notice.value, /選択を解除/)
  h.c.selectAll(true); assert.deepEqual(h.c.selectedPaths.value, ['原稿.txt']); h.c.selectAll(false); assert.equal(h.c.selectedPaths.value.length, 0)
})

test('フォルダー切替は旧入力をリセットし、状態取得失敗でも履歴の読込を試みる', async () => {
  let unavailable = false
  const h = harness({ invoke: async r => { if (r.kind === 'status' && unavailable) throw new Error('権限がありません') } })
  h.workspaces.push({ id: 2, root: 'C:/別作品', backup: null, authorName: '別の名前', authorEmail: '' })
  await h.c.open(); h.c.description.value = '前のメモ'; unavailable = true; await h.c.select(2)
  assert.equal(h.c.description.value, ''); assert.equal(h.c.status.value, null); assert.equal(h.c.statusFailed.value, true)
  assert.ok(h.c.recordDisabledReason.value); assert.equal(h.c.historyReady.value, true)
  await h.c.setBackup(); assert.equal(h.calls.some(r => r.kind === 'setBackup'), false)
})

test('一度の確認失敗後も同じフォルダーの選択を保持し、初回失敗後は登録済みの名前を補完する', async () => {
  let unavailable = false
  const h = harness({ invoke: async r => { if (r.kind === 'status' && unavailable) throw new Error('一時的に確認できません') } })
  h.state.changes.push({ path: '別章.txt', kind: 'added' }); await h.c.open()
  h.c.selectedPaths.value = ['別章.txt']; h.c.description.value = '推敲途中'
  unavailable = true; await h.c.refresh(); assert.equal(h.c.status.value, null)
  unavailable = false; await h.c.refresh()
  assert.deepEqual(h.c.selectedPaths.value, ['別章.txt']); assert.equal(h.c.description.value, '推敲途中')
  const first = harness({ invoke: async r => { if (r.kind === 'status' && unavailable) throw new Error('一時的に確認できません') } })
  first.state.authorName = ''; first.workspaces[0].authorName = '登録した筆名'
  unavailable = true; await first.c.open(); unavailable = false; await first.c.refresh()
  assert.equal(first.c.authorName.value, '登録した筆名')
})

test('履歴取得失敗を空履歴扱いせず、初回は最新記録と唯一の原稿を表示する', async () => {
  let fail = false
  const h = harness({ invoke: async r => {
    if (r.kind === 'history') { if (fail) throw new Error('履歴が壊れています'); return [{ id: 'first', date: '', message: '初稿', author: '作者' }] }
  } })
  await h.c.open(); assert.equal(h.c.selectedCommit.value, 'first'); assert.equal(h.c.selectedFile.value, '原稿.txt')
  assert.equal(h.c.preview.value, 'A\r\n'); fail = true; await h.c.refresh()
  assert.equal(h.c.historyReady.value, false); assert.equal(h.c.historyFailed.value, true); assert.equal(h.c.selectedFile.value, null)
  assert.equal(h.c.preview.value, ''); assert.equal(h.c.entries.value.length, 0)
})

test('原稿の取得失敗時は前の本文を消し、取り出し操作も無効にする', async () => {
  let fail = false
  const h = harness({ invoke: async r => {
    if (r.kind === 'files') return ['第一章/原稿.txt', '第二章/原稿.txt']
    if (r.kind === 'blob' && fail) throw new Error('内容を取得できません')
  } })
  await h.c.open(); await h.c.selectCommit('first'); assert.equal(h.c.selectedFile.value, null)
  await h.c.selectFile('第一章/原稿.txt'); assert.equal(h.c.preview.value, 'A\r\n')
  fail = true; await h.c.selectFile('第二章/原稿.txt')
  assert.equal(h.c.preview.value, ''); assert.equal(h.c.selectedFile.value, null); assert.match(h.c.previewError.value, /取得できません/)
  await h.c.exportFile(); assert.equal(h.calls.some(r => r.kind === 'export'), false)
})

test('空本文と文字コード表示不能は取得失敗と区別し、元内容の取り出しを許可する', async () => {
  let bytes = []
  const h = harness({ save: async () => 'D:/new.txt', invoke: async r => { if (r.kind === 'blob') return bytes } })
  await h.c.open(); await h.c.selectCommit('first'); assert.equal(h.c.selectedFile.value, '原稿.txt')
  assert.equal(h.c.preview.value, ''); assert.equal(h.c.previewError.value, '')
  bytes = [255]; await h.c.selectFile('原稿.txt'); assert.match(h.c.previewError.value, /UTF-8/)
  await h.c.exportFile(); assert.equal(h.calls.filter(r => r.kind === 'export').length, 1)
})

test('記録済み内容のバックアップは未保存編集を含めず、状態が不明でも成功を捏造しない', async () => {
  const h = harness(); h.state.backupState = 'current'; await h.c.open(); h.dirty.value = true
  assert.equal(h.c.backupDisabledReason.value, ''); await h.c.backup()
  assert.equal(h.saves(), 0); assert.match(h.c.notice.value, /未保存・未記録の変更は含まれません/)
  h.state.backupState = 'unknown'; await h.c.refresh(); assert.equal(h.c.status.value.backupState, 'unknown')
})

test('部分成功の種類と出力先を表示し、元の詳細を再確認結果で失わない', async () => {
  const h = harness({ invoke: async r => {
    if (r.kind === 'record') throw { kind: 'recordedNeedsAttention', details: 'index.lock を保持', output: '記録ID' }
  } })
  await h.c.open(); await h.c.beginRecord()
  assert.match(h.c.feedback.value.message, /履歴は記録されました/); assert.equal(h.c.feedback.value.output, '記録ID')
  const { describeGitFailure } = loadSourceModule('src/gitHistoryPresentation.ts')
  const restored = describeGitFailure({ kind: 'restoredRegistrationFailed', details: 'DB failure', output: 'D:/restored' }, 'restore')
  assert.match(restored.message, /復元は完了/); assert.match(restored.action, /再度復元せず/)
  const incomplete = describeGitFailure({ kind: 'outputIncomplete', details: 'write failure', output: 'D:/partial.txt' }, 'export')
  assert.match(incomplete.action, /不完全/); assert.equal(incomplete.output, 'D:/partial.txt')
})

test('復元候補1件は自動選択し、親フォルダー選択の取消では復元しない', async () => {
  let choosing = true
  const h = harness({ choose: async () => choosing ? 'D:/backup' : null, invoke: async r => {
    if (r.kind === 'branches') return [{ name: 'main', id: 'a', date: '', message: '初稿' }]
  } })
  await h.c.open(); await h.c.beginRestore(); assert.equal(h.c.restoreBranch.value, 'main')
  choosing = false; await h.c.chooseRestoreParent(); await h.c.restore()
  assert.equal(h.c.restoreParent.value, ''); assert.equal(h.calls.some(r => r.kind === 'restore'), false)
})


test('記録成功後の再確認失敗を記録失敗と混同せず、作成済みの履歴を案内する', async () => {
  let recorded = false
  const h = harness({ invoke: async r => {
    if (r.kind === 'record') { recorded = true; return 'new-id' }
    if (r.kind === 'list' && recorded) throw new Error('登録一覧を読めません')
  } })
  await h.c.open(); await h.c.beginRecord()
  assert.match(h.c.notice.value, /履歴を記録しました/)
  assert.match(h.c.feedback.value.message, /現在の状態を確認/)
  assert.equal(h.c.status.value, null); assert.ok(h.c.recordDisabledReason.value)
  assert.equal(h.calls.filter(r => r.kind === 'record').length, 1)
})

test('履歴の有無と変更0件を区別し、空状態では次の操作を案内する', async () => {
  const h = harness(); h.state.changes = []; h.state.head = ''; await h.c.open()
  assert.equal(h.c.membership.value, 'noHistory')
  assert.match(h.c.overview.value.states[1].message, /まだ一度も/)
  assert.match(h.c.overview.value.states[1].detail, /0件/)
  assert.equal(h.c.overview.value.next.target, 'editor')
  h.state.head = 'b'.repeat(40); await h.c.refresh()
  assert.match(h.c.overview.value.states[1].message, /履歴が残っています/)
  assert.equal(h.c.overview.value.next.target, 'backup')
  assert.ok(h.c.recordDisabledReason.value)
  await h.c.beginRecord(); assert.equal(h.calls.some(r => r.kind === 'record'), false)
})

test('対象外・未保存・外部変更・欠落・確認失敗を原稿の正常状態と混同しない', async () => {
  const h = harness(); h.state.changes = []; await h.c.open()
  h.path.value = null; h.dirty.value = true
  assert.match(h.c.overview.value.states[0].message, /無題.*対象外/)
  assert.equal(h.c.overview.value.states[0].tone, 'neutral')
  h.path.value = 'C:/作品別/原稿.txt'
  assert.equal(h.c.membership.value, 'outside'); assert.match(h.c.overview.value.states[0].detail, /まだ保存/)
  h.path.value = 'C:/作品/原稿.txt'; await h.c.refresh()
  assert.equal(h.c.overview.value.next.target, 'editor')
  h.dirty.value = false
  for (const state of ['changed', 'missing', 'error']) {
    h.externalState.value = state
    assert.notEqual(h.c.overview.value.states[0].tone, 'success')
    assert.match(h.c.overview.value.states[0].detail, /本文は保持/)
    assert.equal(h.c.overview.value.next.target, 'editor')
  }
  h.externalState.value = 'unchanged'; assert.equal(h.c.overview.value.states[0].tone, 'success')
})

test('バックアップ済みは記録だけを指し、未保存・未記録を含むと案内しない', async () => {
  const h = harness(); h.state.backupState = 'current'; await h.c.open()
  assert.match(h.c.overview.value.states[2].message, /最新の記録/)
  assert.match(h.c.overview.value.states[2].detail, /含まれていません/)
  assert.match(h.c.overview.value.states[0].detail, /変更前/)
  h.state.changes = []; await h.c.refresh(); h.dirty.value = true
  assert.equal(h.c.overview.value.next.target, 'editor'); assert.match(h.c.overview.value.states[2].detail, /含まれていません/)
  h.dirty.value = false; assert.equal(h.c.overview.value.next.target, 'history')
  for (const [state, target, tone] of [['different', 'backup', 'warning'], ['unknown', 'refresh', 'error'], ['notSet', 'backup', 'warning']]) {
    h.state.backupState = state; await h.c.refresh()
    assert.equal(h.c.overview.value.next.target, target); assert.equal(h.c.overview.value.states[2].tone, tone)
  }
})

test('最新記録への収録確認はプレビュー選択と独立し、対象外の原稿を収録済みと扱わない', async () => {
  const h = harness({ invoke: async r => {
    if (r.kind === 'history') return [{ id: 'past', date: '', message: '以前の原稿', author: '作者' }]
    if (r.kind === 'files') return r.commit === 'past' ? ['別の原稿.txt'] : ['原稿.txt']
  } })
  h.state.changes = []; await h.c.open()
  assert.equal(h.c.membership.value, 'present'); assert.equal(h.c.selectedFile.value, '別の原稿.txt')
  await h.c.selectCommit('other'); assert.equal(h.c.membership.value, 'present')
  h.path.value = 'C:/作品/履歴にない原稿.txt'; await h.c.refresh()
  assert.equal(h.c.membership.value, 'absent'); assert.equal(h.c.overview.value.next.target, 'details')
  assert.equal(h.c.overview.value.states[0].tone, 'warning')
})

test('収録確認の失敗は未確認とし、履歴プレビューの成功で収録済みに戻さない', async () => {
  const h = harness({ invoke: async r => {
    if (r.kind === 'files' && r.commit === 'a'.repeat(40)) throw { kind: 'unknown', details: '最新版を読めません', output: null }
    if (r.kind === 'history') return [{ id: 'past', date: '', message: '', author: '' }]
  } })
  await h.c.open()
  assert.equal(h.c.membership.value, 'unknown'); assert.equal(h.c.membershipError.value, '最新版を読めません')
  assert.equal(h.c.selectedFile.value, '原稿.txt'); assert.equal(h.c.preview.value, 'A\r\n')
  assert.equal(h.c.overview.value.states[0].tone, 'error')
  assert.equal(h.c.overview.value.next.target, 'refresh'); assert.equal(h.c.overview.value.next.tone, 'error')
})

test('収録確認前の文書変更と破棄後の応答を現在の原稿へ反映しない', async () => {
  const waiting = deferred()
  const started = deferred()
  const h = harness({ invoke: async r => { if (r.kind === 'files') { started.release(); return waiting.promise } } })
  const opening = h.c.open()
  // 取得開始を待つ間も、本文や履歴を変更する操作は行われない。
  await started.promise
  h.path.value = 'C:/作品/別の原稿.txt'; waiting.release(['別の原稿.txt']); await opening
  assert.equal(h.c.membership.value, 'unknown')
  const late = deferred()
  const lateStarted = deferred()
  const disposed = harness({ invoke: async r => { if (r.kind === 'files') { lateStarted.release(); return late.promise } } })
  const pending = disposed.c.open()
  await lateStarted.promise
  disposed.c.dispose(); late.release(['原稿.txt']); await pending
  assert.notEqual(disposed.c.membership.value, 'present')
})

test('表示更新は情報通知、記録成功は成功通知、部分成功は注意として扱う', async () => {
  const h = harness(); await h.c.open(); h.state.changes = []; await h.c.refresh()
  assert.equal(h.c.noticeTone.value, 'info'); assert.match(h.c.notice.value, /一覧を更新/)
  h.state.changes = [{ path: '原稿.txt', kind: 'modified' }]; await h.c.refresh()
  await h.c.beginRecord(); assert.equal(h.c.noticeTone.value, 'success')
  const { describeGitFailure } = loadSourceModule('src/gitHistoryPresentation.ts')
  for (const kind of ['recordedNeedsAttention', 'restoredRegistrationFailed', 'outputIncomplete']) assert.equal(describeGitFailure({ kind, details: '詳細', output: '出力先' }, 'record').tone, 'warning')
  assert.equal(describeGitFailure(new Error('失敗'), 'record').tone, 'error')
})

test('記録成功後に対象一覧から変更がなくなっても、成功の案内と次の操作を保持する', async () => {
  const h = harness({ invoke: async r => {
    if (r.kind === 'record') { h.state.changes = []; return 'new-id' }
  } })
  await h.c.open(); await h.c.beginRecord()
  assert.match(h.c.notice.value, /このPCに履歴を記録/)
  assert.equal(h.c.noticeTone.value, 'success'); assert.equal(h.c.noticeAction.value, 'backup')
  assert.equal(h.c.selectedPaths.value.length, 0)
})
