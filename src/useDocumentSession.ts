/** 本文とファイル操作をメイン画面のライフサイクルから分離し、復元処理へ橋渡しする。 */
import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import { fingerprintBytes } from './sidebarAnalysis'
import type { DocumentSnapshot, DocumentNavigation } from './sidebarModel'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { createEmptyStatistics } from './statisticsCalculation'
import type { EditorStatistics } from './statisticsCalculation'
import { authorizeProjectFile, loadProjectTreeSnapshot } from './projectTreeClient'
import { useDocumentRecovery } from './useDocumentRecovery'
import { authorizeRecentFile, sameRecentFilePath, updateRecentFilePosition, type RecentFile } from './recentFiles'
import type { EditorPosition } from './editorNavigation'
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
  /** 主カーソルの論理行と書記素列を返す。 */
  getPosition: () => EditorPosition
  /** 解析時点の本文・選択・限定範囲を世代と一緒に返す。 */
  getDocumentSnapshot: () => DocumentSnapshot
  /** 世代の一致した範囲だけへ移動し、本文やUndo履歴を保持する。 */
  revealRange: (target: DocumentNavigation) => boolean
  /** Workerで確認済みの一致位置を強調する。本文は変更しない。 */
  setSidebarMatches: (revision: number, ranges: { from: number; to: number }[]) => void
  /** 本文と初期位置を切り替え、編集履歴を初期化する。 */
  setDocument: (text: string, position?: EditorPosition | null) => void
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
type SaveOutcome = 'saved' | 'cancelled' | 'conflict' | 'failed'

export type DocumentSessionOptions = {
  editor: Ref<DocumentEditorHandle | null>
  mainCloseInProgress: Ref<boolean>
  showPersistenceNotice: (text: string) => void
  showError: (action: string, error: unknown) => Promise<void>
  reportProjectTreeOpenResult: (result: ProjectTreeOpenResult, sourceWindowId?: string) => void
  /** 読込・保存成功を記録し、同じ履歴IDと前回の位置を返す。失敗は本文操作と切り離す。 */
  onFileAccessed?: (path: string) => Promise<RecentFile>
  /** Git履歴などのモーダル中は分離ツリーからの文書切替も止める。 */
  fileNavigationBlocked?: Readonly<Ref<boolean>>
}

/** 本文の状態とファイル・復元APIを接続し、保存基準を一か所で管理する。 */
export function useDocumentSession(options: DocumentSessionOptions) {
  const path = ref<string | null>(null)
  const documentOrigin = ref<DocumentOrigin | null>(null)
  const savedText = ref('')
  const dirty = ref(false)
  const saveRevision = ref(0)
  const statistics = ref<EditorStatistics>(createEmptyStatistics())
  const busy = ref(true)
  const documentLocked = ref(true)
  const currentFile = ref<TextFile | null>(null)
  const documentFormat = ref<{ lineEnding: LineEnding; hasBom: boolean }>({ lineEnding: '\n', hasBom: false })
  const suggestedFileName = ref('無題.txt')
  const restoredUnsaved = ref(false)
  const displayName = computed(() => path.value ? fileName(path.value) : restoredUnsaved.value ? suggestedFileName.value : '無題')

  let disposed = false
  let recentFileId: number | null = null
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
      const position = options.editor.value?.getPosition()
      recovery.flush()
      currentFile.value = file
      documentFormat.value = { lineEnding: file.lineEnding, hasBom: file.hasBom }
      restoredUnsaved.value = false
      options.editor.value?.setDocument(file.text, position)
      file.editorText = options.editor.value?.getText() ?? file.text
      savedText.value = file.editorText
      dirty.value = false
      const recent = await recordFileAccess(target)
      if (disposed) return
      recentFileId = recent?.id ?? null
      await persistEditorPosition()
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
  async function recordFileAccess(filePath: string): Promise<RecentFile | null> {
    if (disposed) return null
    try {
      const recent = await options.onFileAccessed?.(filePath)
      return disposed ? null : recent ?? null
    } catch (error) {
      if (!disposed) options.showPersistenceNotice(`ファイル履歴を保存できません。${String(error)}`)
      return null
    }
  }

  /** 現在の履歴IDと位置をawait前に固定する。失敗しても文書操作を中止しない。 */
  async function persistEditorPosition(): Promise<void> {
    if (disposed || recentFileId === null || !options.editor.value) return
    const id = recentFileId
    const position = options.editor.value.getPosition()
    try {
      await updateRecentFilePosition(id, position)
    } catch (error) {
      if (!disposed) options.showPersistenceNotice(`編集位置を保存できません。${String(error)}`)
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

  /** 外部の本文を再読込する前に、現在の未保存変更を破棄してよいか確認する。 */
  async function confirmDiscard(): Promise<boolean> {
    if (!dirty.value) return true
    const confirmed = await ask('未保存の変更があります。破棄して続けますか？', {
      title: '小説エディタ',
      kind: 'warning',
    })
    return disposed ? false : confirmed
  }

  /**
   * 切替・終了前に未保存本文の扱いを確認する。呼出側が本文と操作をロックしたまま使用する。
   * 保存本体だけを呼び、外側のロックを解除しない。競合時は要求を保留せず中止する。
   */
  async function confirmDocumentTransition(): Promise<boolean> {
    if (disposed || !documentLocked.value || (!busy.value && !options.mainCloseInProgress.value)) return false
    if (!dirty.value) return true
    const saveLabel = '保存して続ける'
    const discardLabel = '保存せず続ける'
    const choice = await message(`「${displayName.value}」に未保存の変更があります。\n保存してから続けますか？`, {
      title: '未保存の原稿',
      kind: 'warning',
      buttons: { yes: saveLabel, no: discardLabel, cancel: 'キャンセル' },
    })
    if (disposed) return false
    if (choice === discardLabel || choice === 'No') return true
    // 閉じる・Esc・未知の応答は取消とし、明示的な保存選択だけ実行する。
    if (choice !== saveLabel && choice !== 'Yes') return false
    const outcome = await saveDocumentContents(false)
    return !disposed && outcome === 'saved' && !dirty.value
  }

  /** 未保存本文の保存・破棄を確認して新規文書へ切り替え、保存先と編集履歴を初期化する。 */
  async function newDocument(): Promise<void> {
    if (disposed || busy.value || externalDialog.value || options.mainCloseInProgress.value) return
    busy.value = true
    externalRevision += 1
    documentLocked.value = true
    try {
      if (!(await confirmDocumentTransition()) || disposed) return
      await persistEditorPosition()
      if (disposed) return
      recovery.flush()
      recentFileId = null
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
        const recent = await recordFileAccess(path.value)
        if (disposed) return false
        recentFileId = recent?.id ?? null
        await persistEditorPosition()
        if (disposed) return false
        options.editor.value?.focus()
        return true
      }
      const selected = await resolvePath()
      if (disposed || !selected) return false
      let file = await loadTextFile(selected)
      const previousSaveRevision = saveRevision.value
      if (disposed || !(await confirmDocumentTransition()) || disposed) return false
      // 保存先が切替先と同じ場合も、確認前に取得した古い本文へ戻さない。
      if (saveRevision.value !== previousSaveRevision) {
        file = await loadTextFile(selected)
        if (disposed) return false
      }
      await persistEditorPosition()
      if (disposed) return false
      const recent = await recordFileAccess(file.path)
      if (disposed) return false
      recovery.flush()
      recentFileId = recent?.id ?? null
      documentOrigin.value = null
      currentFile.value = file
      path.value = file.path
      documentFormat.value = { lineEnding: file.lineEnding, hasBom: file.hasBom }
      suggestedFileName.value = fileName(file.path)
      restoredUnsaved.value = false
      options.editor.value?.setDocument(file.text, recent?.position)
      // CodeMirror は改行を内部表現へ揃えるため、未保存判定の基準も読み込み後の本文に合わせる。
      file.editorText = options.editor.value?.getText() ?? file.text
      savedText.value = file.editorText
      dirty.value = false
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
      options.reportProjectTreeOpenResult({ requestId: request.requestId, nodeId: request.nodeId, outcome: 'failed', error: '別の操作中のため、ファイルを開けませんでした。' }, sourceWindowId)
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
      let file = await loadTextFile(authorizedPath)
      if (request.searchFingerprint && await fingerprintBytes(file.originalBytes) !== request.searchFingerprint) throw new Error('検索後に原稿が変更されています。もう一度検索してください。')
      const previousSaveRevision = saveRevision.value
      if (disposed || !(await confirmDocumentTransition()) || disposed) {
        if (disposed) return
        options.reportProjectTreeOpenResult({ requestId: request.requestId, nodeId: request.nodeId, outcome: 'cancelled' }, sourceWindowId)
        return
      }
      // 保存した場合も再取得し、許可先の再指定や外部更新後の古い本文・位置へ移動しない。
      if (request.searchFingerprint || saveRevision.value !== previousSaveRevision) {
        const latestPath = await authorizeProjectFile(request.nodeId)
        if (disposed) return
        if (!sameRecentFilePath(latestPath, authorizedPath)) throw new Error('登録先が変更されました。もう一度検索してください。')
        const latest = await loadTextFile(latestPath)
        if (disposed) return
        if (request.searchFingerprint) {
          const latestFingerprint = await fingerprintBytes(latest.originalBytes)
          if (disposed) return
          if (latestFingerprint !== request.searchFingerprint) throw new Error('確認中に原稿が変更されました。もう一度検索してください。')
        }
        file = latest
      }
      await persistEditorPosition()
      if (disposed) return
      const recent = await recordFileAccess(file.path)
      if (disposed) return
      recovery.flush()
      recentFileId = recent?.id ?? null
      currentFile.value = file
      path.value = file.path
      documentOrigin.value = { nodeId: request.nodeId, projectId: request.projectId }
      documentFormat.value = { lineEnding: file.lineEnding, hasBom: file.hasBom }
      suggestedFileName.value = fileName(file.path)
      restoredUnsaved.value = false
      // 検索結果は呼出側が一致位置へ移動するため、記憶位置のスクロールを挟まない。
      options.editor.value?.setDocument(file.text, request.searchFingerprint ? undefined : recent?.position)
      file.editorText = options.editor.value?.getText() ?? file.text
      savedText.value = file.editorText
      dirty.value = false
      await recovery.syncSnapshot()
      if (disposed) return
      options.editor.value?.focus()
      options.reportProjectTreeOpenResult({ requestId: request.requestId, nodeId: request.nodeId, outcome: 'opened' }, sourceWindowId)
    } catch (error) {
      if (disposed) return
      options.reportProjectTreeOpenResult({
        requestId: request.requestId,
        nodeId: request.nodeId,
        error: String(error),
        unavailable,
        outcome: 'failed',
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

  /** 通常保存の排他制御を担う。本文はロックせず、書込中の追加入力を許可する。 */
  async function saveCurrentDocument(saveAs: boolean, approvedConflict?: FileConflict): Promise<void> {
    if (disposed || busy.value || options.mainCloseInProgress.value) return
    busy.value = true
    try {
      await saveDocumentContents(saveAs, approvedConflict)
    } finally {
      if (!disposed) busy.value = false
    }
  }

  /**
   * 内容照合と保存基準の更新を行い、結果を返す。排他制御と本文ロックは呼出側が所有する。
   * 競合・取消・失敗では切替を許可せず、書込中の追加入力も未保存として保護する。
   */
  async function saveDocumentContents(saveAs: boolean, approvedConflict?: FileConflict): Promise<SaveOutcome> {
    if (disposed) return 'cancelled'
    externalRevision += 1
    try {
      const target = approvedConflict?.path ?? (!saveAs && path.value ? path.value : await chooseSavePath(path.value ?? suggestedFileName.value))
      if (disposed || !target) return 'cancelled'
      const previousPath = path.value
      let expected: DiskState
      if (approvedConflict) {
        if (approvedConflict.disk.kind === 'error') return 'failed'
        const confirmed = await ask(approvedConflict.disk.kind === 'missing'
          ? `同じ場所に現在の本文を保存し直しますか？\n${target}`
          : `外部で変更された内容は失われます。現在の本文で上書きしますか？\n${target}`, {
          title: '外部更新の確認', kind: 'warning', okLabel: approvedConflict.disk.kind === 'missing' ? '再作成' : '上書き', cancelLabel: 'キャンセル',
        })
        if (disposed || !confirmed) return 'cancelled'
        expected = approvedConflict.disk
      } else {
        const disk = await inspectTextFile(target)
        if (disposed) return 'cancelled'
        if (disk.kind === 'error') { showFileConflict(target, disk); return 'failed' }
        if (currentFile.value && previousPath && sameRecentFilePath(target, previousPath)
          && classifyExternalFile(disk, currentFile.value.originalBytes) !== 'unchanged') {
          showFileConflict(target, disk)
          return 'conflict'
        }
        expected = disk
      }
      const text = options.editor.value?.getText() ?? ''
      const { lineEnding, hasBom } = documentFormat.value
      const result = await saveTextFile(target, text, lineEnding, hasBom, expected, currentFile.value ?? undefined)
      if (disposed) return 'cancelled'
      if (result.kind === 'conflict') { showFileConflict(target, result.disk); return 'conflict' }
      // 別名保存では元履歴の位置を残してから、新しい保存先へ履歴IDを切り替える。
      if (previousPath && !sameRecentFilePath(previousPath, target)) {
        await persistEditorPosition()
        if (disposed) return 'cancelled'
      }
      path.value = target
      if (!previousPath || !sameRecentFilePath(previousPath, target)) documentOrigin.value = null
      currentFile.value = result.file
      saveRevision.value++
      suggestedFileName.value = fileName(target)
      restoredUnsaved.value = false
      savedText.value = text
      // 書き込み中にも編集できるので、保存開始時の本文と現在の本文を改めて比較する。
      dirty.value = (options.editor.value?.getText() ?? '') !== text
      const recent = await recordFileAccess(target)
      if (disposed) return 'cancelled'
      recentFileId = recent?.id ?? null
      await persistEditorPosition()
      if (disposed) return 'cancelled'
      await recovery.syncSnapshot()
      return disposed ? 'cancelled' : 'saved'
    } catch (error) {
      if (disposed) return 'cancelled'
      await options.showError('保存', error)
      return 'failed'
    }
  }

  /** 終了前に復元タイマーを止め、現在の編集位置の書込完了を待つ。 */
  async function flush(): Promise<void> {
    recovery.flush()
    await persistEditorPosition()
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
    saveRevision,
    statistics,
    busy,
    documentLocked,
    displayName,
    onChange,
    initializeRecovery,
    confirmDocumentTransition,
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
