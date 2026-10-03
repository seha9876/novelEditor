/** 現在のTXTの過去状態だけを読む。管理・記録・送信は既存画面へ委ねる。 */
import { computed, ref, watch, type Ref } from 'vue'
import { save } from '@tauri-apps/plugin-dialog'
import { gitHistory, isInsideGitWorkspace, gitWorkspaceOriginalRelativePath, type GitWorkspace, type GitList, type GitFileEntry, type GitFileHistoryPage, type GitRequest } from './gitHistory'
import { describeGitFailure } from './gitHistoryPresentation'
import { decodeTextFile } from './textFile'
type Options = { path: Readonly<Ref<string | null>>; active: Readonly<Ref<boolean>>; disabled: Readonly<Ref<boolean>>; refreshRevision: Ref<number> }

/** 文書切替前の応答を捨て、読み取り中は執筆を妨げず、出力中は終了を待たせる。 */
export function useSidebarHistory(options: Options) {
  const workspace = ref<GitWorkspace | null>(null), entries = ref<GitFileEntry[]>([]), selected = ref<GitFileEntry | null>(null)
  const head = ref(''), branch = ref(''), hasMore = ref(false), preview = ref(''), previewError = ref(''), previewReady = ref(false)
  const pending = ref(false), exporting = ref(false), notice = ref(''), message = ref(''), feedback = ref<ReturnType<typeof describeGitFailure> | null>(null)
  const canExport = computed(() => previewReady.value && !!selected.value?.path && !pending.value && !exporting.value && !options.disabled.value)
  let generation = 0, disposed = false, refreshAgain = false

  /** 保存済み管理IDだけを送り、任意コマンドや登録操作を簡易画面から実行しない。 */
  async function request<T>(command: GitRequest): Promise<T> { return gitHistory<T>(command) }
  /** 文書変更時には古い選択本文を先に消し、別原稿の内容として見せない。 */
  function clear(): void { entries.value = []; selected.value = null; preview.value = ''; previewError.value = ''; previewReady.value = false; head.value = ''; branch.value = ''; hasMore.value = false }
  /** 取得成功とUTF-8表示可否を分け、表示不可でも元バイト列の取り出しを許可する。 */
  async function loadPreview(entry: GitFileEntry, own: number): Promise<void> {
    selected.value = entry; preview.value = ''; previewError.value = ''; previewReady.value = false
    if (!entry.path || !workspace.value) return
    try {
      const bytes = await request<number[]>({ kind: 'blob', id: workspace.value.id, commit: entry.id, path: entry.path })
      if (disposed || own !== generation) return
      previewReady.value = true
      try { preview.value = decodeTextFile(entry.path, new Uint8Array(bytes)).text }
      catch { previewError.value = 'UTF-8ではないため表示できません。元の内容は別のファイルとして取り出せます。' }
    } catch (reason) { if (!disposed && own === generation) { previewError.value = '本文を取得できませんでした。記録を選び直してください。'; feedback.value = describeGitFailure(reason, 'preview') } }
  }
  /** 再表示と保存後だけ再確認し、進行中の旧応答は完了後に最新対象へ読み直す。 */
  async function refresh(): Promise<void> {
    if (disposed || !options.active.value || options.disabled.value) return
    if (pending.value || exporting.value) { refreshAgain = true; return }
    const own = ++generation, path = options.path.value, preferred = selected.value?.id
    pending.value = true; message.value = '履歴を確認中です…'; feedback.value = null; notice.value = ''
    try {
      if (!path) { clear(); workspace.value = null; message.value = '無題の原稿です。保存して管理フォルダーに登録すると履歴を確認できます。'; return }
      const list = await request<GitList>({ kind: 'list' })
      if (disposed || own !== generation) return
      const current = list.workspaces.filter(item => isInsideGitWorkspace(path, item.root)).sort((a, b) => b.root.length - a.root.length)[0]
      if (current?.id !== workspace.value?.id) clear()
      workspace.value = current ?? null
      if (!list.version) { clear(); message.value = '履歴機能にはGit for Windowsが必要です。管理画面で導入方法を確認できます。'; if (list.error) feedback.value = describeGitFailure(list.error, 'check'); return }
      if (!current) { message.value = 'この原稿の保存先は履歴管理に登録されていません。'; return }
      const page = await request<GitFileHistoryPage>({ kind: 'fileHistory', id: current.id, path: gitWorkspaceOriginalRelativePath(path, current.root), offset: 0, head: '' })
      if (disposed || own !== generation) return
      entries.value = page.entries; head.value = page.head; branch.value = page.branch; hasMore.value = page.hasMore
      message.value = page.entries.length ? '' : '現在の保存場所・ファイル名には、まだ記録がありません。'
      const entry = page.entries.find(item => item.id === preferred) ?? page.entries[0]
      if (entry) await loadPreview(entry, own)
      else { selected.value = null; preview.value = ''; previewError.value = ''; previewReady.value = false }
    } catch (reason) { if (!disposed && own === generation) { clear(); message.value = '履歴を確認できませんでした。再確認してください。'; feedback.value = describeGitFailure(reason, 'history') } }
    finally { pending.value = false; if (refreshAgain) { refreshAgain = false; void refresh() } }
  }
  /** 選択時には本文を先に消し、読み取りだけでは編集中の原稿を変更しない。 */
  async function select(entry: GitFileEntry): Promise<void> {
    if (disposed || !options.active.value || pending.value || exporting.value || options.disabled.value || !entries.value.some(item => item.id === entry.id && item.path === entry.path)) return
    pending.value = true; feedback.value = null
    try { await loadPreview(entry, generation) }
    finally { pending.value = false; if (refreshAgain) { refreshAgain = false; void refresh() } }
  }
  /** 同じ基準記録の続きを読み、基準が変わった場合は混ぜず再確認を促す。 */
  async function more(): Promise<void> {
    const current = workspace.value, path = options.path.value, own = generation
    if (disposed || !options.active.value || !current || !path || !hasMore.value || pending.value || exporting.value || options.disabled.value) return
    pending.value = true
    try { const page = await request<GitFileHistoryPage>({ kind: 'fileHistory', id: current.id, path: gitWorkspaceOriginalRelativePath(path, current.root), offset: entries.value.length, head: head.value }); if (own === generation && !disposed) { entries.value.push(...page.entries); hasMore.value = page.hasMore } }
    catch (reason) { if (own === generation && !disposed) feedback.value = describeGitFailure(reason, 'history') }
    finally { pending.value = false; if (refreshAgain) { refreshAgain = false; void refresh() } }
  }
  /** 選択済みの記録を新規TXTにだけ出力し、文書切替や既存原稿への復元はしない。 */
  async function exportFile(): Promise<void> {
    const current = workspace.value, entry = selected.value
    if (disposed || !canExport.value || !current || !entry?.path) return
    exporting.value = true; feedback.value = null; notice.value = ''
    try {
      const destination = await save({ title: '別のファイルとして取り出す（上書きしません）', defaultPath: entry.path.split('/').pop()!.replace(/\.txt$/i, '-履歴.txt'), filters: [{ name: 'TXT', extensions: ['txt'] }] })
      if (!destination || disposed) return
      await request({ kind: 'export', id: current.id, commit: entry.id, path: entry.path, destination })
      if (!disposed) notice.value = `別のファイルとして取り出しました。\n${destination}`
    } catch (reason) { if (!disposed) feedback.value = describeGitFailure(reason, 'export') }
    finally { exporting.value = false; if (refreshAgain) { refreshAgain = false; void refresh() } }
  }
  const stops = [watch(options.path, () => { generation++; clear(); workspace.value = null; void refresh() }), watch(options.refreshRevision, () => { generation++; void refresh() }), watch([options.active, options.disabled], () => {
    if (!options.active.value || options.disabled.value) { generation++; refreshAgain = false }
    else void refresh()
  }, { immediate: true })]
  /** 遅着応答を破棄し、終了時のGit実行待ちはメイン側に残す。 */
  function dispose(): void { disposed = true; generation++; stops.forEach(stop => stop()) }
  return { workspace, entries, selected, head, branch, hasMore, preview, previewError, previewReady, pending, exporting, canExport, message, feedback, notice, refresh, select, more, exportFile, dispose }
}
