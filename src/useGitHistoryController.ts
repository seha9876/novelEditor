/** Git の非同期操作、確認画面、文書保存との連携をメイン窓に集約する。 */
import { computed, ref, type Ref } from 'vue'
import { ask, open as choose, save } from '@tauri-apps/plugin-dialog'
import { gitHistory, isInsideGitWorkspace, type GitEntry, type GitList, type GitRequest, type GitStatus, type GitWorkspace } from './gitHistory'

type Options = {
  isOpen: Ref<boolean>; disabled: Readonly<Ref<boolean>>; path: Readonly<Ref<string | null>>; dirty: Readonly<Ref<boolean>>
  saveDocument: () => Promise<void>
}

/** 操作を一つずつ実行し、画面の破棄後には取得結果を適用しない。 */
export function useGitHistoryController(options: Options) {
  const pending = ref(false)
  const error = ref('')
  const notice = ref('')
  const version = ref<string | null>(null)
  const workspaces = ref<GitWorkspace[]>([])
  const selectedId = ref<number | null>(null)
  const workspace = computed(() => workspaces.value.find(w => w.id === selectedId.value) ?? null)
  const status = ref<GitStatus | null>(null)
  const selectedPaths = ref<string[]>([])
  const description = ref('')
  const authorName = ref('')
  const authorEmail = ref('')
  const entries = ref<GitEntry[]>([])
  const hasMore = ref(false)
  const selectedCommit = ref<string | null>(null)
  const files = ref<string[]>([])
  const selectedFile = ref<string | null>(null)
  const preview = ref('')
  const previewError = ref('')
  const savePrompt = ref(false)
  const restoreSource = ref('')
  const restoreBranches = ref<string[]>([])
  const restoreBranch = ref('')
  const restoreName = ref('復元した原稿')
  const unsaved = computed(() => !!workspace.value && options.dirty.value && isInsideGitWorkspace(options.path.value, workspace.value.root))
  let disposed = false

  /** 破棄後の遅着結果を画面へ反映させない通信ラッパー。 */
  async function request<T>(command: GitRequest): Promise<T> {
    if (disposed) throw new Error('画面は終了しています')
    const result = await gitHistory<T>(command)
    if (disposed) throw new Error('画面は終了しています')
    return result
  }

  /** 二重実行を防ぎ、失敗を画面内に表示する。終了側は pending の間待機を案内する。 */
  async function run(action: () => Promise<void>): Promise<void> {
    if (disposed || pending.value || options.disabled.value) return
    pending.value = true; error.value = ''; notice.value = ''
    try { await action() }
    catch (reason) { if (!disposed) error.value = String(reason) }
    finally { if (!disposed) pending.value = false }
  }

  /** 選択した管理フォルダーの状態と最初の履歴ページを最新化する。 */
  async function loadState(): Promise<void> {
    status.value = null; selectedPaths.value = []; entries.value = []; selectedCommit.value = null
    files.value = []; selectedFile.value = null; preview.value = ''; previewError.value = ''; hasMore.value = false
    const current = workspace.value
    if (!current || !version.value) return
    const result = await request<GitStatus>({ kind: 'status', id: current.id })
    status.value = result; selectedPaths.value = result.changes.map(c => c.path)
    authorName.value = result.authorName || current.authorName
    authorEmail.value = result.authorEmail || current.authorEmail
    const page = await request<GitEntry[]>({ kind: 'history', id: current.id, offset: 0 })
    entries.value = page; hasMore.value = page.length === 50
  }

  /** 管理登録を読み直し、直前の選択を可能な限り保持する。 */
  async function loadList(preferredRoot?: string): Promise<void> {
    const result = await request<GitList>({ kind: 'list' })
    workspaces.value = result.workspaces; version.value = result.version
    selectedId.value = result.workspaces.find(w => preferredRoot ? w.root === preferredRoot : w.id === selectedId.value)?.id ?? result.workspaces[0]?.id ?? null
    if (result.error) error.value = result.error
    await loadState()
  }

  /** 毎回最新の登録と Git 状態を取得して画面を開く。 */
  async function open(): Promise<void> {
    if (disposed || options.disabled.value || pending.value) return
    options.isOpen.value = true
    await run(() => loadList())
  }

  /** 実行中以外に閉じる。次回に未完了の確認を持ち越さない。 */
  function close(): void {
    if (pending.value) return
    savePrompt.value = false; restoreSource.value = ''; options.isOpen.value = false
  }

  /** 別フォルダーへ切り替え、前の本文プレビューと操作対象をリセットする。 */
  async function select(id: number): Promise<void> {
    await run(async () => { selectedId.value = id; description.value = ''; await loadState() })
  }

  /** 明示更新により外部 Git ツールの操作結果を取り込む。 */
  async function refresh(): Promise<void> { await run(() => loadList()) }

  /** 選択範囲と実際のルートを確認してから Git 管理へ登録する。 */
  async function add(): Promise<void> {
    await run(async () => {
      const path = await choose({ directory: true, multiple: false, title: '履歴を管理する原稿フォルダー' })
      if (!path || disposed) return
      const root = await request<string>({ kind: 'inspect', path })
      if (!await ask(`次のフォルダー全体を履歴管理へ登録します。\n${root}\n\nGit がなければ作成します。原稿は移動しません。`, { title: '管理フォルダーの確認', kind: 'info' }) || disposed) return
      await request({ kind: 'register', path, expectedRoot: root })
      await loadList(root)
    })
  }

  /** 登録だけを解除し、原稿と Git 履歴は残す。 */
  async function remove(): Promise<void> {
    const current = workspace.value
    if (!current) return
    await run(async () => {
      if (!await ask('この一覧から登録を解除しますか？ 原稿・履歴・バックアップは残ります。', { title: '登録の解除', kind: 'info' }) || disposed) return
      await request({ kind: 'remove', id: current.id }); await loadList()
    })
  }

  /** 未保存の本文がある場合は保存方針だけを先に確認する。 */
  async function beginRecord(): Promise<void> {
    if (pending.value || options.disabled.value || !status.value || status.value.blocked) return
    if (unsaved.value) { savePrompt.value = true; return }
    await record('disk')
  }

  /** 必要な通常保存が成功した場合だけ、最新の一覧で記録を再確認する。 */
  async function record(choice: 'save' | 'disk' | 'cancel'): Promise<void> {
    savePrompt.value = false
    if (choice === 'cancel' || !workspace.value || !status.value) return
    const current = workspace.value; const snapshot = status.value
    const paths = [...selectedPaths.value]
    await run(async () => {
      if (choice === 'save') {
        await options.saveDocument()
        if (disposed) return
        if (options.dirty.value) { error.value = '保存が完了していないため、記録していません。原稿の保存を確認してください。'; return }
        await loadState()
        notice.value = '保存しました。更新された変更一覧を確認し、もう一度「履歴を記録」を押してください。'
        return
      }
      try {
        await request<string>({ kind: 'record', id: current.id, token: snapshot.token, paths,
          message: description.value.trim() || `原稿の記録 ${new Date().toLocaleString('ja-JP')}`,
          authorName: authorName.value, authorEmail: authorEmail.value })
        description.value = ''; await loadList(); notice.value = '履歴を記録しました。別ドライブへ保護するには「バックアップ」を押してください。'
      } catch (reason) {
        try { await loadState() } catch { /* 元の記録エラーを優先する。 */ }
        throw reason
      }
    })
  }

  /** 次の50件を追加し、すでに表示した履歴を保持する。 */
  async function more(): Promise<void> {
    if (!workspace.value || !hasMore.value) return
    await run(async () => {
      const page = await request<GitEntry[]>({ kind: 'history', id: workspace.value!.id, offset: entries.value.length })
      entries.value.push(...page); hasMore.value = page.length === 50
    })
  }

  /** 選んだ記録の TXT 一覧だけを取得する。 */
  async function selectCommit(id: string): Promise<void> {
    if (!workspace.value) return
    await run(async () => {
      const result = await request<string[]>({ kind: 'files', id: workspace.value!.id, commit: id })
      selectedCommit.value = id; files.value = result; selectedFile.value = null; preview.value = ''; previewError.value = ''
    })
  }

  /** 過去の本文を読み取り専用で表示し、不正UTF-8を置換せず知らせる。 */
  async function selectFile(path: string): Promise<void> {
    if (!workspace.value || !selectedCommit.value) return
    await run(async () => {
      const bytes = await request<number[]>({ kind: 'blob', id: workspace.value!.id, commit: selectedCommit.value!, path })
      selectedFile.value = path; preview.value = ''; previewError.value = ''
      try { preview.value = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)) }
      catch { previewError.value = 'UTF-8 ではないためプレビューできません。元のバイト列で取り出すことはできます。' }
    })
  }

  /** 新しい名前へ取り出す。本文セッションやファイル履歴は切り替えない。 */
  async function exportFile(): Promise<void> {
    if (!workspace.value || !selectedCommit.value || !selectedFile.value) return
    await run(async () => {
      const destination = await save({ title: '新しい名前で取り出す（既存ファイルには上書きしません）', defaultPath: selectedFile.value!.split('/').pop()!.replace(/\.txt$/i, '-履歴.txt'), filters: [{ name: 'TXT', extensions: ['txt'] }] })
      if (!destination || disposed) return
      await request({ kind: 'export', id: workspace.value!.id, commit: selectedCommit.value!, path: selectedFile.value!, destination })
      notice.value = `取り出しました: ${destination}`
    })
  }

  /** 空のフォルダーまたは既存bareを保管先に指定する。 */
  async function setBackup(): Promise<void> {
    if (!workspace.value) return
    await run(async () => {
      const path = await choose({ directory: true, multiple: false, title: '空のフォルダーまたは保管用Gitを選択' })
      if (!path || disposed) return
      if (!await ask(`${path}\n\nここをバックアップ先にします。空のフォルダーなら保管用 Git を作成します。`, { title: 'バックアップ先', kind: 'info' }) || disposed) return
      await request({ kind: 'setBackup', id: workspace.value!.id, path }); await loadList()
    })
  }

  /** 現在のブランチの記録を送信し、成功後に保管先の状態を取り直す。 */
  async function backup(): Promise<void> {
    if (!workspace.value || !status.value) return
    await run(async () => {
      try {
        await request({ kind: 'backup', id: workspace.value!.id, token: status.value!.token })
        await loadState(); notice.value = '現在のブランチの記録をバックアップしました。'
      } catch (reason) {
        try { await loadState() } catch { /* 接続失敗時にも、送信のエラーを優先する。 */ }
        throw reason
      }
    })
  }

  /** 元の原稿フォルダーがなくても、保管先から復元候補を取得できるようにする。 */
  async function beginRestore(): Promise<void> {
    await run(async () => {
      const path = await choose({ directory: true, multiple: false, title: '復元元の保管用Gitを選択' })
      if (!path || disposed) return
      const branches = await request<string[]>({ kind: 'branches', path })
      if (!branches.length) throw new Error('復元できるブランチがありません')
      restoreSource.value = path; restoreBranches.value = branches; restoreBranch.value = branches[0]!
    })
  }

  /** 選んだ親フォルダー内に新しい名前で独立復元する。 */
  async function restore(): Promise<void> {
    await run(async () => {
      const parent = await choose({ directory: true, multiple: false, title: '復元先の親フォルダーを選択' })
      if (!parent || disposed) return
      const root = await request<string>({ kind: 'restore', path: restoreSource.value, parent, name: restoreName.value, branch: restoreBranch.value })
      restoreSource.value = ''; await loadList(root); notice.value = `復元しました: ${root}`
    })
  }

  /** 終了後の状態更新を抑止する。実行中のGitはApp側の終了制御で待機する。 */
  function dispose(): void { disposed = true }

  return { isOpen: options.isOpen, pending, error, notice, version, workspaces, selectedId, workspace, status,
    selectedPaths, description, authorName, authorEmail, entries, hasMore, selectedCommit, files, selectedFile,
    preview, previewError, savePrompt, unsaved, restoreSource, restoreBranches, restoreBranch, restoreName,
    open, close, select, refresh, add, remove, beginRecord, record, more, selectCommit, selectFile, exportFile,
    setBackup, backup, beginRestore, restore, dispose }
}
