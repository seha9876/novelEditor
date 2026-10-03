/** 本文とファイル操作をメイン画面のライフサイクルから分離し、復元処理へ橋渡しする。 */
import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import { ask } from '@tauri-apps/plugin-dialog'
import { createEmptyStatistics } from './statisticsCalculation'
import type { EditorStatistics } from './statisticsCalculation'
import { authorizeProjectFile, loadProjectTreeSnapshot } from './projectTreeClient'
import { useDocumentRecovery } from './useDocumentRecovery'
import { authorizeRecentFile, sameRecentFilePath, type RecentFile } from './recentFiles'
import { classifyExternalFile, inspectTextFile, type DiskObservation, type DiskState, type FileConflict, type ExternalFileState } from './externalFile'
import {
  chooseSavePath,
  chooseTextFile,
  fileName,
  loadTextFile,
  saveTextFile,
  type LineEnding,
  type TextFile,
} from './textFile'
import type { ProjectTreeOpenRequest, ProjectTreeOpenResult } from './projectTreeWindow'
import type { SearchAction, SearchConditions, SearchScopeAction, SearchScopeStatus } from './searchSession'

export type DocumentEditorHandle = {
  /** CodeMirror が保持する現在の本文を返す。 */
  getText: () => string
  /** 本文を切り替え、編集履歴を初期化する。 */
  setDocument: (text: string) => void
  /** 本文領域へ入力フォーカスを移す。 */
  focus: () => void
  /** 検索条件とハイライトの有効状態を本文へ反映する。 */
  setSearch: (conditions: SearchConditions, active: boolean) => void
  /** 本文の選択とUndo履歴を使って検索・置換を実行する。 */
  runSearch: (action: SearchAction) => void
  /** 本文を渡さず、限定範囲と現在の選択可否だけを返す。 */
  getSearchScope: () => SearchScopeStatus
  /** 現在の選択で検索範囲を指定するか、全文検索へ戻す。 */
  setSearchScope: (action: SearchScopeAction) => boolean
}

type DocumentOrigin = { nodeId: number; projectId: number }

export type DocumentSessionOptions = {
  editor: Ref<DocumentEditorHandle | null>
  mainCloseInProgress: Ref<boolean>
  showPersistenceNotice: (text: string) => void
  showError: (action: string, error: unknown) => Promise<void>
  reportProjectTreeOpenResult: (result: ProjectTreeOpenResult, sourceWindowId?: string) => void
  /** 原稿の読込・保存成功を通知する。失敗は本文操作と切り離して知らせる。 */
  onFileAccessed?: (path: string) => Promise<void>
  /** Git履歴などのモーダル中は分離ツリーからの文書切替も止める。 */
  fileNavigationBlocked?: Readonly<Ref<boolean>>
}

/** 本文の状態とファイル・復元APIを接続し、保存基準を一か所で管理する。 */
export function useDocumentSession(options: DocumentSessionOptions) {
  const path = ref<string | null>(null)
  const documentOrigin = ref<DocumentOrigin | null>(null)
  const savedText = ref('')
  const dirty = ref(false)
  const statistics = ref<EditorStatistics>(createEmptyStatistics())
  const busy = ref(true)
  const documentLocked = ref(true)
  const currentFile = ref<TextFile | null>(null)
  const documentFormat = ref<{ lineEnding: LineEnding; hasBom: boolean }>({ lineEnding: '\n', hasBom: false })
  const suggestedFileName = ref('無題.txt')
  const restoredUnsaved = ref(false)
  const displayName = computed(() => path.value ? fileName(path.value) : restoredUnsaved.value ? suggestedFileName.value : '無題')

  let disposed = false
  const externalState = ref<ExternalFileState>('unchanged')
  const externalError = ref('')
  const externalDialog = shallowRef<FileConflict | null>(null)
  let externalRevision = 0
  let checkingExternal = false
  const stopFileWatch = watch(currentFile, () => {
    externalRevision += 1
    externalState.value = 'unchanged'
    externalError.value = ''
    externalDialog.value = null
  }, { flush: 'sync' })

  /** 現在のファイルの状態だけを通知へ反映し、本文と保存基準は変更しない。 */
  function applyExternalObservation(target: string, disk: DiskObservation): void {
    if (!currentFile.value || !path.value || !sameRecentFilePath(target, path.value)) return
    externalState.value = classifyExternalFile(disk, currentFile.value.originalBytes)
    externalError.value = disk.kind === 'error' ? disk.message : ''
  }

  /** 前面監視からの要求を一本化し、文書操作前に開始した古い応答は捨てる。 */
  async function checkExternalFile(): Promise<void> {
    if (disposed || checkingExternal || busy.value || externalDialog.value || options.mainCloseInProgress.value || !currentFile.value) return
    const baseline = currentFile.value
    const revision = externalRevision
    checkingExternal = true
    try {
      const disk = await inspectTextFile(baseline.path)
      if (disposed || revision !== externalRevision || busy.value || options.mainCloseInProgress.value || baseline !== currentFile.value) return
      applyExternalObservation(baseline.path, disk)
    } finally { checkingExternal = false }
  }

  /** 保存先の競合を表示する。別名保存先の競合では元文書の通知状態を変えない。 */
  function showFileConflict(target: string, disk: DiskObservation): void {
    applyExternalObservation(target, disk)
    externalDialog.value = { path: target, disk }
  }

  /** 通知または再確認から最新状態を取得し、解消していれば選択画面も閉じる。 */
  async function reviewExternalFile(): Promise<void> {
    if (disposed || busy.value || options.mainCloseInProgress.value) return
    const target = externalDialog.value?.path ?? path.value
    if (!target) return
    busy.value = true
    externalRevision += 1
    try {
      const disk = await inspectTextFile(target)
      if (disposed) return
      applyExternalObservation(target, disk)
      if (path.value && sameRecentFilePath(target, path.value) && externalState.value === 'unchanged') externalDialog.value = null
      else showFileConflict(target, disk)
    } finally { if (!disposed) busy.value = false }
  }

  /** 通知は残したまま選択画面だけを閉じ、次の保存時には必ず再検査する。 */
  function deferExternalFile(): void {
    if (!busy.value) externalDialog.value = null
  }

  /** 同じ原稿を明示再読込する。未保存確認後に読み直し、成功するまで現在の本文を保持する。 */
  async function reloadExternalFile(): Promise<void> {
    const target = externalDialog.value?.path
    if (disposed || busy.value || options.mainCloseInProgress.value || !target || !path.value || !sameRecentFilePath(target, path.value)) return
    busy.value = true
    documentLocked.value = true
    externalRevision += 1
    try {
      if (!(await confirmDiscard()) || disposed) return
      const file = await loadTextFile(target)
      if (disposed) return
      recovery.flush()
      currentFile.value = file
      documentFormat.value = { lineEnding: file.lineEnding, hasBom: file.hasBom }
      restoredUnsaved.value = false
      options.editor.value?.setDocument(file.text)
      file.editorText = options.editor.value?.getText() ?? file.text
      savedText.value = file.editorText
      dirty.value = false
      await recordFileAccess(target)
      if (disposed) return
      await recovery.syncSnapshot()
    } catch (error) {
      if (!disposed) showFileConflict(target, { kind: 'error', message: String(error) })
    } finally {
      if (!disposed) { busy.value = false; documentLocked.value = false }
    }
  }

  /** 確認画面で見たディスク内容を期待値にして上書きし、確認中の再変更も検出する。 */
  async function overwriteExternalFile(): Promise<void> {
    const conflict = externalDialog.value
    if (conflict && conflict.disk.kind !== 'error') await saveCurrentDocument(false, conflict)
  }

  /** 履歴だけの保存失敗を通知し、成功した文書の読込・保存を失敗扱いにしない。 */
  async function recordFileAccess(filePath: string): Promise<void> {
    if (disposed) return
    try {
      await options.onFileAccessed?.(filePath)
    } catch (error) {
      if (!disposed) options.showPersistenceNotice(`ファイル履歴を保存できません。${String(error)}`)
    }
  }

  const recovery = useDocumentRecovery({
    getSnapshot: () => dirty.value ? {
      schemaVersion: 1,
      text: options.editor.value?.getText() ?? '',
      fileName: path.value ? fileName(path.value) : suggestedFileName.value,
      ...documentFormat.value,
      updatedAt: new Date().toISOString(),
    } : null,
    applySnapshot: (snapshot) => {
      suggestedFileName.value = snapshot.fileName
      documentFormat.value = { lineEnding: snapshot.lineEnding, hasBom: snapshot.hasBom }
      restoredUnsaved.value = true
      options.editor.value?.setDocument(snapshot.text)
    },
    onInitializationFinished: () => {
      busy.value = false
      documentLocked.value = false
    },
    focusEditor: () => options.editor.value?.focus(),
    showPersistenceNotice: options.showPersistenceNotice,
  })

  /** CodeMirrorの本文変更だけから未保存状態を判定する。統計・選択の通知は関与しない。 */
  function onChange(text: string): void {
    dirty.value = restoredUnsaved.value || text !== savedText.value
    recovery.scheduleSave()
  }

  /** 復元候補を確認し、保存先を持たない未保存文書として開く。空の本文でも明示保存までは未保存を維持する。 */
  async function initializeRecovery(): Promise<boolean> {
    return recovery.initialize()
  }

  /** 未保存の変更を破棄してよいか確認し、続行できる場合に true を返す。確認ダイアログを開く。 */
  async function confirmDiscard(): Promise<boolean> {
    if (!dirty.value) return true
    const confirmed = await ask('未保存の変更があります。破棄して続けますか？', {
      title: '小説エディタ',
      kind: 'warning',
    })
    return disposed ? false : confirmed
  }

  /** 必要なら破棄を確認して新規文書へ切り替え、保存先と編集履歴を初期化する。 */
  async function newDocument(): Promise<void> {
    if (disposed || busy.value || externalDialog.value || options.mainCloseInProgress.value) return
    busy.value = true
    externalRevision += 1
    documentLocked.value = true
    try {
      if (!(await confirmDiscard()) || disposed) return
      recovery.flush()
      path.value = null
      documentOrigin.value = null
      currentFile.value = null
      documentFormat.value = { lineEnding: '\n', hasBom: false }
      suggestedFileName.value = '無題.txt'
      restoredUnsaved.value = false
      savedText.value = ''
      options.editor.value?.setDocument('')
      await recovery.syncSnapshot()
      if (disposed) return
      options.editor.value?.focus()
    } catch (error) {
      if (disposed) return
      await options.showError('新規作成', error)
    } finally {
      if (!disposed) {
        busy.value = false
        documentLocked.value = false
      }
    }
  }

  /** ファイル選択から共通の読込処理を呼び、失敗は通常のエラーダイアログで知らせる。 */
  async function openDocument(): Promise<void> {
    try {
      await openDocumentFromPath(chooseTextFile)
    } catch (error) {
      if (!disposed) await options.showError('ファイルを開く操作', error)
    }
  }

  /** 履歴を許可して既存の読込処理へ渡す。失敗理由は履歴画面、取消はfalseで返す。 */
  async function openRecentDocument(file: RecentFile): Promise<boolean> {
    return openDocumentFromPath(() => authorizeRecentFile(file.id), file.path)
  }

  /** ファイル選択と履歴で未保存確認・本文適用・復元更新を共有し、取消時は現状を保つ。 */
  async function openDocumentFromPath(resolvePath: () => Promise<string | null>, recentPath?: string): Promise<boolean> {
    if (disposed || busy.value || externalDialog.value || options.mainCloseInProgress.value) return false
    busy.value = true
    externalRevision += 1
    documentLocked.value = true
    try {
      if (recentPath && path.value && sameRecentFilePath(path.value, recentPath)) {
        await recordFileAccess(path.value)
        if (disposed) return false
        options.editor.value?.focus()
        return true
      }
      const selected = await resolvePath()
      if (disposed || !selected) return false
      const file = await loadTextFile(selected)
      if (disposed || !(await confirmDiscard()) || disposed) return false
      recovery.flush()
      documentOrigin.value = null
      currentFile.value = file
      path.value = file.path
      documentFormat.value = { lineEnding: file.lineEnding, hasBom: file.hasBom }
      suggestedFileName.value = fileName(file.path)
      restoredUnsaved.value = false
      options.editor.value?.setDocument(file.text)
      // CodeMirror は改行を内部表現へ揃えるため、未保存判定の基準も読み込み後の本文に合わせる。
      file.editorText = options.editor.value?.getText() ?? file.text
      savedText.value = file.editorText
      dirty.value = false
      await recordFileAccess(file.path)
      if (disposed) return false
      await recovery.syncSnapshot()
      if (disposed) return false
      options.editor.value?.focus()
      return true
    } finally {
      if (!disposed) {
        busy.value = false
        documentLocked.value = false
      }
    }
  }

  /** ツリーの要求元を問わずモーダルと参照先を検証して開く。検索候補は取得時のパスも照合する。 */
  async function openProjectTreeFile(request: ProjectTreeOpenRequest, sourceWindowId?: string): Promise<void> {
    if (disposed) return
    if (busy.value || externalDialog.value || options.fileNavigationBlocked?.value || options.mainCloseInProgress.value) {
      options.reportProjectTreeOpenResult({ requestId: request.requestId, nodeId: request.nodeId, error: '別の操作中のため、ファイルを開けませんでした。' }, sourceWindowId)
      return
    }
    busy.value = true
    externalRevision += 1
    documentLocked.value = true
    let unavailable = false
    try {
      const snapshot = await loadProjectTreeSnapshot()
      if (disposed) return
      const node = snapshot.nodes.find((item) => item.id === request.nodeId)
      if (!node || node.kind !== 'file' || node.projectId !== request.projectId) {
        unavailable = true
        throw new Error('選択した登録ファイルは既に変更されています。')
      }
      if (request.expectedPath !== undefined && node.path !== request.expectedPath) {
        throw new Error('検索候補の参照先が変更されています。もう一度検索してください。')
      }
      let authorizedPath: string
      try {
        authorizedPath = await authorizeProjectFile(request.nodeId)
        if (disposed) return
      } catch (error) {
        unavailable = true
        throw error
      }
      // スナップショット取得後にも別画面から再指定できるため、許可された実際の参照先を照合する。
      if (request.expectedPath !== undefined && authorizedPath !== request.expectedPath) {
        throw new Error('検索候補の参照先が変更されています。もう一度検索してください。')
      }
      const file = await loadTextFile(authorizedPath)
      if (disposed || !(await confirmDiscard()) || disposed) {
        if (disposed) return
        options.reportProjectTreeOpenResult({ requestId: request.requestId, nodeId: request.nodeId }, sourceWindowId)
        return
      }
      recovery.flush()
      currentFile.value = file
      path.value = file.path
      documentOrigin.value = { nodeId: request.nodeId, projectId: request.projectId }
      documentFormat.value = { lineEnding: file.lineEnding, hasBom: file.hasBom }
      suggestedFileName.value = fileName(file.path)
      restoredUnsaved.value = false
      options.editor.value?.setDocument(file.text)
      file.editorText = options.editor.value?.getText() ?? file.text
      savedText.value = file.editorText
      dirty.value = false
      await recordFileAccess(file.path)
      if (disposed) return
      await recovery.syncSnapshot()
      if (disposed) return
      options.editor.value?.focus()
      options.reportProjectTreeOpenResult({ requestId: request.requestId, nodeId: request.nodeId }, sourceWindowId)
    } catch (error) {
      if (disposed) return
      options.reportProjectTreeOpenResult({
        requestId: request.requestId,
        nodeId: request.nodeId,
        error: String(error),
        unavailable,
      }, sourceWindowId)
    } finally {
      if (!disposed) {
        busy.value = false
        documentLocked.value = false
      }
    }
  }

  /** 現在の本文を TXT に書き込み、成功した内容を保存済みの基準にする。保存先がなければ選択を求める。 */
  async function saveDocument(): Promise<void> {
    await saveCurrentDocument(false)
  }

  /** 常に保存先を確認し、成功後は別名のファイルを現在の保存先として扱う。 */
  async function saveDocumentAs(): Promise<void> {
    await saveCurrentDocument(true)
  }

  /** 内容照合を伴う保存を行い、競合・取消では保存基準を保つ。確認中・保存中の追加編集も保護する。 */
  async function saveCurrentDocument(saveAs: boolean, approvedConflict?: FileConflict): Promise<void> {
    if (disposed || busy.value || options.mainCloseInProgress.value) return
    busy.value = true
    externalRevision += 1
    try {
      const target = approvedConflict?.path ?? (!saveAs && path.value ? path.value : await chooseSavePath(path.value ?? suggestedFileName.value))
      if (disposed || !target) return
      const previousPath = path.value
      let expected: DiskState
      if (approvedConflict) {
        if (approvedConflict.disk.kind === 'error') return
        const confirmed = await ask(approvedConflict.disk.kind === 'missing'
          ? `同じ場所に現在の本文を保存し直しますか？\n${target}`
          : `外部で変更された内容は失われます。現在の本文で上書きしますか？\n${target}`, {
          title: '外部更新の確認', kind: 'warning', okLabel: approvedConflict.disk.kind === 'missing' ? '再作成' : '上書き', cancelLabel: 'キャンセル',
        })
        if (disposed || !confirmed) return
        expected = approvedConflict.disk
      } else {
        const disk = await inspectTextFile(target)
        if (disposed) return
        if (disk.kind === 'error') { showFileConflict(target, disk); return }
        if (currentFile.value && previousPath && sameRecentFilePath(target, previousPath)
          && classifyExternalFile(disk, currentFile.value.originalBytes) !== 'unchanged') {
          showFileConflict(target, disk)
          return
        }
        expected = disk
      }
      const text = options.editor.value?.getText() ?? ''
      const { lineEnding, hasBom } = documentFormat.value
      const result = await saveTextFile(target, text, lineEnding, hasBom, expected, currentFile.value ?? undefined)
      if (disposed) return
      if (result.kind === 'conflict') { showFileConflict(target, result.disk); return }
      path.value = target
      if (!previousPath || !sameRecentFilePath(previousPath, target)) documentOrigin.value = null
      currentFile.value = result.file
      suggestedFileName.value = fileName(target)
      restoredUnsaved.value = false
      savedText.value = text
      // 書き込み中にも編集できるので、保存開始時の本文と現在の本文を改めて比較する。
      dirty.value = (options.editor.value?.getText() ?? '') !== text
      await recordFileAccess(target)
      if (disposed) return
      await recovery.syncSnapshot()
      if (disposed) return
    } catch (error) {
      if (disposed) return
      await options.showError('保存', error)
    } finally {
      if (!disposed) busy.value = false
    }
  }

  /** 終了前に遅延中の復元保存だけを取り消し、呼び出し元の削除処理へ順序を渡す。 */
  function flush(): void {
    recovery.flush()
  }

  /** 保存済み復元候補を明示的に削除する。終了処理では自動保存より後に呼び出す。 */
  async function clearRecoverySnapshot(): Promise<void> {
    await recovery.clear()
  }

  /** 終了処理が取り消された場合に復元保存を再開する。 */
  function resumeRecoverySave(): void {
    recovery.resume()
  }

  /** 文書セッションのタイマーと復元状態を破棄する。 */
  function dispose(): void {
    disposed = true
    externalRevision += 1
    stopFileWatch()
    externalDialog.value = null
    recovery.dispose()
  }

  /** ツリー側の登録解除に合わせ、本文の出自だけを解除する。 */
  function detachDocumentOrigin(nodeId: number): void {
    if (documentOrigin.value?.nodeId === nodeId) documentOrigin.value = null
  }

  return {
    externalState, externalError, externalDialog,
    checkExternalFile, reviewExternalFile, deferExternalFile, reloadExternalFile, overwriteExternalFile,
    path,
    documentOrigin,
    dirty,
    statistics,
    busy,
    documentLocked,
    displayName,
    onChange,
    initializeRecovery,
    confirmDiscard,
    newDocument,
    openDocument,
    openRecentDocument,
    openProjectTreeFile,
    saveDocument,
    saveDocumentAs,
    flush,
    clearRecoverySnapshot,
    resumeRecoverySave,
    dispose,
    detachDocumentOrigin,
  }
}
