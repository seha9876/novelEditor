/** 本文とファイル操作をメイン画面のライフサイクルから分離し、復元処理へ橋渡しする。 */
import { computed, ref, type Ref } from 'vue'
import { ask } from '@tauri-apps/plugin-dialog'
import { createEmptyStatistics } from './statisticsCalculation'
import type { EditorStatistics } from './statisticsCalculation'
import { authorizeProjectFile, loadProjectTreeSnapshot } from './projectTreeClient'
import { useDocumentRecovery } from './useDocumentRecovery'
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
import type { SearchAction, SearchConditions } from './searchSession'

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
}

type DocumentOrigin = { nodeId: number; projectId: number }

export type DocumentSessionOptions = {
  editor: Ref<DocumentEditorHandle | null>
  mainCloseInProgress: Ref<boolean>
  showPersistenceNotice: (text: string) => void
  showError: (action: string, error: unknown) => Promise<void>
  reportProjectTreeOpenResult: (result: ProjectTreeOpenResult, sourceWindowId?: string) => void
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
    if (disposed || busy.value || options.mainCloseInProgress.value) return
    busy.value = true
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

  /** 選択した TXT を読み込み、本文・保存先・未保存判定の基準を更新する。選択取消時は現状を保つ。 */
  async function openDocument(): Promise<void> {
    if (disposed || busy.value || options.mainCloseInProgress.value) return
    busy.value = true
    documentLocked.value = true
    try {
      const selected = await chooseTextFile()
      if (disposed || !selected) return
      const file = await loadTextFile(selected)
      if (disposed || !(await confirmDiscard()) || disposed) return
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
      await recovery.syncSnapshot()
      if (disposed) return
      options.editor.value?.focus()
    } catch (error) {
      if (disposed) return
      await options.showError('ファイルを開く操作', error)
    } finally {
      if (!disposed) {
        busy.value = false
        documentLocked.value = false
      }
    }
  }

  /** ツリーの要求元を問わず、メイン画面で参照先を検証して本文へ開く。 */
  async function openProjectTreeFile(request: ProjectTreeOpenRequest, sourceWindowId?: string): Promise<void> {
    if (disposed) return
    if (busy.value || options.mainCloseInProgress.value) {
      options.reportProjectTreeOpenResult({ requestId: request.requestId, nodeId: request.nodeId, error: '別の操作中のため、ファイルを開けませんでした。' }, sourceWindowId)
      return
    }
    busy.value = true
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
      let authorizedPath: string
      try {
        authorizedPath = await authorizeProjectFile(request.nodeId)
        if (disposed) return
      } catch (error) {
        unavailable = true
        throw error
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

  /** 保存開始時の本文を記録し、書き込み中に増えた編集は未保存と復元候補に残す。 */
  async function saveCurrentDocument(saveAs: boolean): Promise<void> {
    if (disposed || busy.value || options.mainCloseInProgress.value) return
    busy.value = true
    try {
      const target = !saveAs && path.value ? path.value : await chooseSavePath(path.value ?? suggestedFileName.value)
      if (disposed || !target) return
      const previousPath = path.value
      const text = options.editor.value?.getText() ?? ''
      const { lineEnding, hasBom } = documentFormat.value
      const savedFile = await saveTextFile(target, text, lineEnding, hasBom, currentFile.value ?? undefined)
      if (disposed) return
      path.value = target
      if (previousPath !== target) documentOrigin.value = null
      currentFile.value = savedFile
      suggestedFileName.value = fileName(target)
      restoredUnsaved.value = false
      savedText.value = text
      // 書き込み中にも編集できるので、保存開始時の本文と現在の本文を改めて比較する。
      dirty.value = (options.editor.value?.getText() ?? '') !== text
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
    recovery.dispose()
  }

  /** ツリー側の登録解除に合わせ、本文の出自だけを解除する。 */
  function detachDocumentOrigin(nodeId: number): void {
    if (documentOrigin.value?.nodeId === nodeId) documentOrigin.value = null
  }

  return {
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
