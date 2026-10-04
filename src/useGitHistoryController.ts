/** 履歴の操作・表示状態・確認画面を管理し、原稿の通常保存だけを既存経路へ委譲する。 */
import { computed, ref, type Ref } from 'vue'
import { ask, open as choose, save } from '@tauri-apps/plugin-dialog'
import { gitHistory, gitWorkspaceRelativePath, isInsideGitWorkspace, type GitBackupBranch, type GitEntry, type GitList, type GitRequest, type GitStatus, type GitWorkspace } from './gitHistory'
import { describeGitFailure, describeGitOverview, operationLabels, recordBlockLabels, type GitOperation, type GitRecordMembership } from './gitHistoryPresentation'
import type { ExternalFileState } from './externalFile'

type Options = {
  isOpen: Ref<boolean>; disabled: Readonly<Ref<boolean>>; path: Readonly<Ref<string | null>>; dirty: Readonly<Ref<boolean>>
  externalState: Readonly<Ref<ExternalFileState>>; externalError: Readonly<Ref<string>>
  saveDocument: () => Promise<void>
}
export type GitHistoryTab = 'record' | 'history' | 'backup'

/** 非同期処理を直列化し、取得失敗や部分成功を空の正常状態として扱わない。 */
export function useGitHistoryController(options: Options) {
  const pending = ref(false)
  const operation = ref<GitOperation>('check')
  const feedback = ref<ReturnType<typeof describeGitFailure> | null>(null)
  const error = computed(() => feedback.value?.details ?? '')
  const notice = ref('')
  const noticeTone = ref<'info' | 'success'>('info')
  const noticeAction = ref<'backup' | null>(null)
  const tab = ref<GitHistoryTab>('record')
  const listReady = ref(false)
  const listFailed = ref(false)
  const version = ref<string | null>(null)
  const workspaces = ref<GitWorkspace[]>([])
  const selectedId = ref<number | null>(null)
  const workspace = computed(() => workspaces.value.find(w => w.id === selectedId.value) ?? null)
  const status = ref<GitStatus | null>(null)
  const statusFailed = ref(false)
  const latestRecordFiles = ref<{ workspaceId: number; head: string; path: string; files: string[] } | null>(null)
  const membershipError = ref('')
  const selectedPaths = ref<string[]>([])
  const description = ref('')
  const authorName = ref('')
  const authorEmail = ref('')
  const entries = ref<GitEntry[]>([])
  const historyReady = ref(false)
  const historyFailed = ref(false)
  const hasMore = ref(false)
  const selectedCommit = ref<string | null>(null)
  const files = ref<string[]>([])
  const filesReady = ref(false)
  const filesFailed = ref(false)
  const selectedFile = ref<string | null>(null)
  const preview = ref('')
  const previewError = ref('')
  const savePrompt = ref(false)
  const restoreSource = ref('')
  const restoreBranches = ref<GitBackupBranch[]>([])
  const restoreBranch = ref('')
  const restoreName = ref('復元した原稿')
  const restoreParent = ref('')
  const restoreDestination = computed(() => restoreParent.value ? `${restoreParent.value.replace(/[\\/]$/, '')}/${restoreName.value.trim()}` : '')
  const currentInside = computed(() => !!workspace.value && isInsideGitWorkspace(options.path.value, workspace.value.root))
  const unsaved = computed(() => currentInside.value && options.dirty.value)
  const pendingLabel = computed(() => operationLabels[operation.value])
  const locked = computed(() => pending.value || options.disabled.value)
  const currentRelativePath = computed(() => workspace.value ? gitWorkspaceRelativePath(options.path.value, workspace.value.root) : null)
  const membership = computed<GitRecordMembership>(() => {
    if (!currentInside.value) return 'outside'
    if (!status.value) return pending.value && !statusFailed.value && !listFailed.value ? 'checking' : 'unknown'
    if (!status.value.head) return 'noHistory'
    const checked = latestRecordFiles.value
    if (!checked || checked.workspaceId !== workspace.value?.id || checked.head !== status.value.head || checked.path !== options.path.value) return pending.value && !membershipError.value ? 'checking' : 'unknown'
    return checked.files.some(file => file.toLowerCase() === currentRelativePath.value) ? 'present' : 'absent'
  })
  const overview = computed(() => describeGitOverview({
    path: options.path.value, dirty: options.dirty.value, inside: currentInside.value, externalState: options.externalState.value,
    currentChanged: !!status.value?.changes.some(change => change.path.toLowerCase() === currentRelativePath.value),
    membership: membership.value, status: status.value, statusFailed: statusFailed.value, listReady: listReady.value,
    listFailed: listFailed.value, version: version.value, historyFailed: historyFailed.value, pending: locked.value,
    pendingLabel: pending.value ? pendingLabel.value : '別の原稿処理を実行中', needsAttention: feedback.value?.tone === 'warning',
  }))
  const recordDisabledReason = computed(() => {
    if (locked.value) return '別の処理が完了するまでお待ちください。'
    if (listReady.value && !version.value) return '履歴機能の準備を終えてから記録できます。'
    if (!status.value) return '現在の状態を確認してから記録できます。「再確認」を押してください。'
    if (status.value.blocked) return recordBlockLabels[status.value.blocked]
    if (!status.value.changes.length) return '保存済みのTXTに、まだ記録していない変更はありません。'
    if (!selectedPaths.value.length) return '記録する原稿を一つ以上選んでください。'
    if (!(status.value.authorName || authorName.value.trim())) return '履歴に表示する名前を入力してください。'
    return ''
  })
  const backupDisabledReason = computed(() => {
    if (locked.value) return '別の処理が完了するまでお待ちください。'
    if (listReady.value && !version.value) return '履歴機能の準備を終えてからバックアップできます。'
    if (!status.value) return '現在の状態を確認してからバックアップできます。'
    if (!workspace.value?.backup) return '先にバックアップ先を選んでください。'
    if (!status.value.head) return '先に「履歴を記録」で、このPCに記録を残してください。'
    if (!status.value.branch) return '記録先が選択されていません。詳しい情報を確認してください。'
    return ''
  })
  const restoreDisabledReason = computed(() => {
    if (locked.value) return '別の処理が完了するまでお待ちください。'
    if (!restoreBranch.value) return '復元する履歴を選んでください。'
    const name = restoreName.value.trim()
    if (!name || /[\\/:]/.test(name) || name === '.' || name === '..') return '新しいフォルダー名を入力してください。区切り文字は使えません。'
    if (!restoreParent.value) return '復元先の親フォルダーを選んでください。'
    return ''
  })
  let disposed = false
  let lastConfirmedStatus: GitStatus | null = null

  /** 破棄後には通信を始めず、すでに開始していた応答も画面へ適用しない。 */
  async function request<T>(command: GitRequest): Promise<T> {
    if (disposed) throw new Error('画面は終了しています')
    const result = await gitHistory<T>(command)
    if (disposed) throw new Error('画面は終了しています')
    return result
  }

  /** 操作と詳細を分けて表示し、部分成功の案内を通常失敗で上書きしない。 */
  function report(reason: unknown, kind: GitOperation): void {
    if (!disposed) feedback.value = describeGitFailure(reason, kind)
  }

  /** 表示更新は情報通知とし、原稿・履歴に関する成功を後続の更新通知で上書きしない。 */
  function notify(message: string, tone: 'info' | 'success', action: 'backup' | null = null): void {
    if (disposed || tone === 'info' && noticeTone.value === 'success' && notice.value) return
    notice.value = message; noticeTone.value = tone; noticeAction.value = action
  }

  /** プレビューの選択とは独立して最新記録を調べ、文書切替前の応答は適用しない。 */
  async function loadLatestRecord(): Promise<void> {
    const current = workspace.value, snapshot = status.value, path = options.path.value
    if (!current || !snapshot?.head || !path || !currentInside.value) return
    try {
      const recordedFiles = await request<string[]>({ kind: 'files', id: current.id, commit: snapshot.head })
      if (workspace.value?.id !== current.id || status.value?.head !== snapshot.head || options.path.value !== path) return
      latestRecordFiles.value = { workspaceId: current.id, head: snapshot.head, path, files: recordedFiles }
    } catch (reason) {
      if (!disposed && workspace.value?.id === current.id && status.value?.head === snapshot.head && options.path.value === path) membershipError.value = describeGitFailure(reason, 'check').details
    }
  }

  /** 操作中の終了を抑止し、表示用の処理名とエラーを通信とは独立して管理する。 */
  async function run(kind: GitOperation, action: () => Promise<void>): Promise<void> {
    if (disposed || locked.value) return
    operation.value = kind; pending.value = true; feedback.value = null; notice.value = ''; noticeTone.value = 'info'; noticeAction.value = null
    try { await action() }
    catch (reason) { report(reason, kind) }
    finally { if (!disposed) pending.value = false }
  }

  /** 選んだ本文を先に消し、取得失敗でも前の原稿を新しい選択の本文として表示しない。 */
  async function loadFile(path: string): Promise<void> {
    selectedFile.value = null; preview.value = ''; previewError.value = ''
    try {
      const bytes = await request<number[]>({ kind: 'blob', id: workspace.value!.id, commit: selectedCommit.value!, path })
      selectedFile.value = path
      try { preview.value = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)) }
      catch { previewError.value = '文字コードがUTF-8ではないため本文を表示できません。元の内容を別のファイルとして取り出すことはできます。' }
    } catch (reason) {
      if (!disposed) { previewError.value = '本文を取得できませんでした。原稿を選び直すか、再確認してください。'; report(reason, 'preview') }
    }
  }

  /** 記録ごとの原稿一覧を取得し、1件だけなら選択の手間なく本文を表示する。 */
  async function loadCommit(id: string, preferredFile?: string | null): Promise<void> {
    selectedCommit.value = id; files.value = []; filesReady.value = false; filesFailed.value = false
    selectedFile.value = null; preview.value = ''; previewError.value = ''
    try {
      files.value = await request<string[]>({ kind: 'files', id: workspace.value!.id, commit: id })
      filesReady.value = true
      const file = preferredFile && files.value.includes(preferredFile) ? preferredFile : files.value.length === 1 ? files.value[0] : null
      if (file) await loadFile(file)
    } catch (reason) { if (!disposed) { filesFailed.value = true; report(reason, 'history') } }
  }

  /** 切替時には前の操作対象を消し、同じフォルダーの再確認では有効な選択と入力を保つ。 */
  function resetSelection(): void {
    lastConfirmedStatus = null
    latestRecordFiles.value = null; membershipError.value = ''
    status.value = null; statusFailed.value = false; selectedPaths.value = []; description.value = ''
    authorName.value = ''; authorEmail.value = ''; entries.value = []; historyReady.value = false; historyFailed.value = false
    selectedCommit.value = null; files.value = []; filesReady.value = false; filesFailed.value = false
    selectedFile.value = null; preview.value = ''; previewError.value = ''; hasMore.value = false
  }

  /** 状態と履歴を個別に確認し、片方の失敗をもう片方の空の正常状態に見せない。 */
  async function loadState(preserve = true): Promise<void> {
    const previousStatus = lastConfirmedStatus
    const paths = [...selectedPaths.value]
    const commit = selectedCommit.value, file = selectedFile.value
    status.value = null; statusFailed.value = false; historyReady.value = false; historyFailed.value = false
    latestRecordFiles.value = null; membershipError.value = ''
    const current = workspace.value
    if (!current) { resetSelection(); return }
    if (!version.value) {
      entries.value = []; selectedCommit.value = null; selectedFile.value = null; files.value = []; preview.value = ''; previewError.value = ''; hasMore.value = false
      return
    }
    try {
      const result = await request<GitStatus>({ kind: 'status', id: current.id })
      status.value = result; lastConfirmedStatus = result
      selectedPaths.value = preserve && previousStatus
        ? result.changes.filter(change => paths.includes(change.path) || !previousStatus.changes.some(old => old.path === change.path)).map(change => change.path)
        : result.changes.map(change => change.path)
      if (!preserve || !previousStatus) {
        if (!authorName.value) authorName.value = result.authorName || current.authorName
        if (!authorEmail.value) authorEmail.value = result.authorEmail || current.authorEmail
      }
      if (preserve && paths.some(path => !result.changes.some(change => change.path === path))) notify('変更一覧を更新しました。対象からなくなった原稿の選択を解除しました。', 'info')
    } catch (reason) { if (!disposed) { statusFailed.value = true; report(reason, 'check') } }
    if (disposed) return
    await loadLatestRecord()
    if (disposed) return
    try {
      const page = await request<GitEntry[]>({ kind: 'history', id: current.id, offset: 0 })
      entries.value = page; historyReady.value = true; hasMore.value = page.length === 50
      if (preserve && commit && !page.some(entry => entry.id === commit)) {
        selectedCommit.value = null; files.value = []; filesReady.value = false; selectedFile.value = null; preview.value = ''; previewError.value = ''
        notify('記録一覧を更新しました。表示対象の記録が一覧からなくなったため、選び直してください。', 'info')
      } else {
        const next = preserve && commit ? commit : page[0]?.id
        if (next) await loadCommit(next, preserve ? file : null)
      }
    } catch (reason) {
      if (!disposed) {
        historyFailed.value = true; entries.value = []; hasMore.value = false; selectedCommit.value = null
        files.value = []; selectedFile.value = null; preview.value = ''; previewError.value = ''
        if (!feedback.value) report(reason, 'history')
      }
    }
  }

  /** 登録一覧を更新し、同じ登録の再確認で入力を初期化しない。 */
  async function loadList(preferredRoot?: string, preserve = true): Promise<void> {
    listFailed.value = false
    try {
      const result = await request<GitList>({ kind: 'list' })
      const oldId = selectedId.value
      workspaces.value = result.workspaces; version.value = result.version; listReady.value = true
      selectedId.value = result.workspaces.find(w => preferredRoot ? w.root === preferredRoot : w.id === oldId)?.id ?? result.workspaces[0]?.id ?? null
      const keep = preserve && oldId === selectedId.value
      if (!keep) resetSelection()
      if (result.error) report(result.error, 'check')
      await loadState(keep)
    } catch (reason) { if (!disposed) { listFailed.value = true; status.value = null }; throw reason }
  }

  /** 毎回状態を確認して開き、最初の目的を記録に揃える。 */
  async function open(preferredRoot?: string): Promise<void> {
    if (disposed || locked.value) return
    options.isOpen.value = true; tab.value = 'record'; listReady.value = false
    await run('check', () => loadList(preferredRoot))
  }

  /** 実行中以外に閉じ、確認画面を次回へ持ち越さない。 */
  function close(): void {
    if (locked.value) return
    savePrompt.value = false; restoreSource.value = ''; options.isOpen.value = false
  }

  /** タブの切替だけではGit操作や入力の初期化を行わない。 */
  function showTab(value: GitHistoryTab): void { tab.value = value }

  /** 別フォルダーの選択は以前の入力や本文を持ち越さず、最新の対象を読み込む。 */
  async function select(id: number): Promise<void> {
    if (id === selectedId.value) return
    await run('check', async () => { selectedId.value = id; resetSelection(); await loadState(false) })
  }

  /** 明示更新だけで外部ツールの変更を取り込み、未確認の値で書き込まない。 */
  async function refresh(): Promise<void> { await run('check', () => loadList()) }

  /** 選んだ場所より広い管理範囲になる場合も、実ルートを確認してから登録する。 */
  async function add(): Promise<void> {
    await run('register', async () => {
      const path = await choose({ directory: true, multiple: false, title: '履歴を残す原稿フォルダーを選択' })
      if (!path || disposed) return
      const root = await request<string>({ kind: 'inspect', path })
      const expanded = root.replace(/\\/g, '/').toLowerCase() !== path.replace(/\\/g, '/').toLowerCase()
      const scope = expanded ? `選んだ場所は、すでに履歴管理されているフォルダーの内部です。次のフォルダー全体が対象になります。\n選んだ場所: ${path}\n\n` : ''
      if (!await ask(`${scope}履歴を残すフォルダー: ${root}\n\n原稿は移動しません。履歴を保存する仕組みがなければ、このフォルダー内に作成します。`, { title: '対象フォルダーの確認', kind: 'info' }) || disposed) return
      await request({ kind: 'register', path, expectedRoot: root }); await loadList(root)
      notify('原稿フォルダーを登録しました。保存済みの変更を選び、履歴を記録できます。', 'success')
    })
  }

  /** 登録だけを解除し、原稿・履歴・バックアップは削除しない。 */
  async function remove(): Promise<void> {
    const current = workspace.value
    if (!current) return
    await run('remove', async () => {
      if (!await ask(`${current.root}\n\nこの一覧から登録を解除しますか？ 原稿・履歴・バックアップは残ります。`, { title: '登録の解除', kind: 'info' }) || disposed) return
      await request({ kind: 'remove', id: current.id }); await loadList()
    })
  }

  /** 全選択と解除は対象一覧内だけに作用し、操作中には変更しない。 */
  function selectAll(selected: boolean): void {
    if (locked.value || !status.value || status.value.blocked) return
    selectedPaths.value = selected ? status.value.changes.map(change => change.path) : []
  }

  /** 未保存の本文について保存方針を確認し、対象の本文を勝手に破棄しない。 */
  async function beginRecord(): Promise<void> {
    if (recordDisabledReason.value) return
    if (unsaved.value) { savePrompt.value = true; return }
    await record('disk')
  }

  /** 通常保存の成功後も変更一覧を見直し、記録する本文を明示的に確認する。 */
  async function record(choice: 'save' | 'disk' | 'cancel'): Promise<void> {
    if (locked.value) return
    savePrompt.value = false
    if (choice === 'cancel' || recordDisabledReason.value || !workspace.value || !status.value) return
    const current = workspace.value, snapshot = status.value, paths = [...selectedPaths.value]
    await run(choice === 'save' ? 'save' : 'record', async () => {
      if (choice === 'save') {
        await options.saveDocument()
        if (disposed) return
        if (options.dirty.value) { report('保存が完了していないため、記録していません。', 'save'); return }
        await loadState()
        notify('保存しました。更新された変更一覧を確認し、もう一度「履歴を記録」を押してください。', 'success')
        return
      }
      try {
        await request<string>({ kind: 'record', id: current.id, token: snapshot.token, paths,
          message: description.value.trim() || `原稿の記録 ${new Date().toLocaleString('ja-JP')}`,
          authorName: authorName.value, authorEmail: authorEmail.value })
      } catch (reason) {
        try { await loadState() } catch { /* 元の失敗と部分成功の情報を優先する。 */ }
        throw reason
      }
      description.value = ''
      notify('このPCに履歴を記録しました。別の保存先にも残すには、バックアップへ進んでください。', 'success', 'backup')
      try { await loadList() } catch (reason) { report(reason, 'check') }
    })
  }

  /** 次の50件を追加し、追加読込失敗でもすでに確認した記録は残す。 */
  async function more(): Promise<void> {
    if (!workspace.value || !hasMore.value) return
    await run('history', async () => {
      const page = await request<GitEntry[]>({ kind: 'history', id: workspace.value!.id, offset: entries.value.length })
      entries.value.push(...page); hasMore.value = page.length === 50
    })
  }

  /** 記録を選び、その時点の原稿だけを読み取り専用の表示へ渡す。 */
  async function selectCommit(id: string): Promise<void> {
    if (!workspace.value) return
    await run('history', () => loadCommit(id))
  }

  /** 本文の取得と文字コードの検証を分け、表示不能でも元データの取り出しを許可する。 */
  async function selectFile(path: string): Promise<void> {
    if (!workspace.value || !selectedCommit.value || !files.value.includes(path)) return
    await run('preview', () => loadFile(path))
  }

  /** 別の新規TXTへ取り出し、現在の本文やファイル履歴を切り替えない。 */
  async function exportFile(): Promise<void> {
    if (!workspace.value || !selectedCommit.value || !selectedFile.value) return
    await run('export', async () => {
      const destination = await save({ title: '別のファイルとして取り出す（既存ファイルには上書きしません）', defaultPath: selectedFile.value!.split('/').pop()!.replace(/\.txt$/i, '-履歴.txt'), filters: [{ name: 'TXT', extensions: ['txt'] }] })
      if (!destination || disposed) return
      await request({ kind: 'export', id: workspace.value!.id, commit: selectedCommit.value!, path: selectedFile.value!, destination })
      notify(`別のファイルとして取り出しました。編集中の本文は変えていません。\n${destination}`, 'success')
    })
  }

  /** 保管専用フォルダーの用途を確認し、原稿フォルダーとの範囲検証はRustへ委譲する。 */
  async function setBackup(): Promise<void> {
    if (!workspace.value || !status.value) return
    await run('setBackup', async () => {
      const path = await choose({ directory: true, multiple: false, title: '別ドライブの空フォルダー、または以前のバックアップ先を選択' })
      if (!path || disposed) return
      if (!await ask(`${path}\n\nここを履歴のバックアップ先にします。空のフォルダーなら保管の仕組みを作成します。TXTを直接開く場所ではありません。バックアップは設定後に手動で行います。`, { title: 'バックアップ先の確認', kind: 'info' }) || disposed) return
      await request({ kind: 'setBackup', id: workspace.value!.id, path }); await loadList()
      notify('バックアップ先を設定しました。記録を送るには「記録をバックアップ」を押してください。', 'success')
    })
  }

  /** 記録済みの履歴だけを送り、送信後に一致を確認する。失敗時も再確認して古い成功表示を残さない。 */
  async function backup(): Promise<void> {
    if (backupDisabledReason.value || !workspace.value || !status.value) return
    await run('backup', async () => {
      try {
        await request({ kind: 'backup', id: workspace.value!.id, token: status.value!.token })
        notify('記録済みの履歴をバックアップしました。未保存・未記録の変更は含まれません。', 'success')
        await loadState()
      } catch (reason) {
        try { await loadState() } catch { /* 元の送信エラーを優先する。 */ }
        throw reason
      }
    })
  }

  /** 復元候補が複数なら自動で選ばず、日時やメモを確認して選択してもらう。 */
  async function beginRestore(): Promise<void> {
    await run('restoreSource', async () => {
      const path = await choose({ directory: true, multiple: false, title: '復元元のバックアップ先を選択' })
      if (!path || disposed) return
      const branches = await request<GitBackupBranch[]>({ kind: 'branches', path })
      if (!branches.length) throw new Error('このバックアップ先には復元できる履歴がありません。記録を送信済みの保管先を選んでください。')
      restoreSource.value = path; restoreBranches.value = branches
      restoreBranch.value = branches.length === 1 ? branches[0]!.name : ''
      restoreParent.value = ''; restoreName.value = '復元した原稿'
    })
  }

  /** 親フォルダーの選択だけでは復元を開始せず、完全な出力先の確認を挟む。 */
  async function chooseRestoreParent(): Promise<void> {
    await run('restoreDestination', async () => {
      const parent = await choose({ directory: true, multiple: false, title: '復元先の親フォルダーを選択' })
      if (parent && !disposed) restoreParent.value = parent
    })
  }

  /** 出力先を確認した明示操作だけで復元し、既存フォルダーを上書きしない。 */
  async function restore(): Promise<void> {
    if (restoreDisabledReason.value) return
    await run('restore', async () => {
      const root = await request<string>({ kind: 'restore', path: restoreSource.value, parent: restoreParent.value, name: restoreName.value.trim(), branch: restoreBranch.value })
      restoreSource.value = ''; notify(`新しいフォルダーへ復元しました。編集中の本文は変えていません。\n${root}`, 'success')
      try { await loadList(root) } catch (reason) { report(reason, 'check') }
    })
  }

  /** 終了後の表示変更を止め、実行中のGitはApp側の終了制御で完了を待つ。 */
  function dispose(): void { disposed = true }

  return { isOpen: options.isOpen, pending, locked, operation, pendingLabel, feedback, error, notice, noticeTone, noticeAction, tab, listReady, listFailed,
    overview, membership, membershipError, externalError: options.externalError,
    version, workspaces, selectedId, workspace, status, statusFailed, selectedPaths, description, authorName, authorEmail, entries,
    historyReady, historyFailed, hasMore, selectedCommit, files, filesReady, filesFailed, selectedFile, preview, previewError,
    savePrompt, currentInside, unsaved, recordDisabledReason, backupDisabledReason, restoreDisabledReason,
    restoreSource, restoreBranches, restoreBranch, restoreName, restoreParent, restoreDestination,
    open, close, showTab, select, refresh, add, remove, selectAll, beginRecord, record, more, selectCommit, selectFile, exportFile,
    setBackup, backup, beginRestore, chooseRestoreParent, restore, dispose }
}
