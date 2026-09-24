<script setup lang="ts">
// 文書操作と画面表示をまとめ、本文そのものは EditorPane の CodeMirror に保持する。
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import EditorPane from './EditorPane.vue'
import ProjectTreeSidebar from './ProjectTreeSidebar.vue'
import StatisticsStatus from './StatisticsStatus.vue'
import { createEmptyStatistics } from './editorStatistics'
import {
  normalizeEditorSettings,
  type EditorSettings,
  type WrapMode,
} from './editorSettings'
import { appCommandDefinitions, findShortcutCommand, type AppCommand, type CommandId } from './appCommands'
import { loadRecoverySnapshot, saveRecoverySnapshot } from './recoveryStore'
import { confirmStorageStartup } from './storageLocation'
import {
  SEARCH_COMMAND_EVENT, SEARCH_STATE_EVENT, SearchSession,
  type SearchAction, type SearchCommand, type SearchConditions, type SearchField, type SearchSnapshot, type SearchStatus,
} from './searchSession'
import {
  saveSettingsPreferences,
  saveProjectTreePreferences,
  normalizeToolbarItems,
  type ApplicationPreferencesV1,
  type PreferencesPersistenceState,
  type ToolbarPreferences,
} from './appPreferences'
import { authorizeProjectFile, loadProjectTreeSnapshot } from './projectTree'
import {
  PROJECT_TREE_WINDOW_COMMAND_EVENT,
  PROJECT_TREE_WINDOW_STATE_EVENT,
  type ProjectTreeOpenRequest,
  type ProjectTreeOpenResult,
  type ProjectTreeWindowCommand,
  type ProjectTreeWindowState,
} from './projectTreeWindow'
import {
  SETTINGS_COMMAND_EVENT,
  SETTINGS_ERROR_EVENT,
  SETTINGS_STATE_EVENT,
  type SettingsCommand,
  type SettingsSnapshot,
} from './settingsSession'
import type { SettingsPageId, SettingsViewId } from './settingsDefinitions'
import {
  chooseSavePath,
  chooseTextFile,
  fileName,
  loadTextFile,
  saveTextFile,
  type LineEnding,
  type TextFile,
} from './textFile'

type EditorHandle = {
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

const props = defineProps<{
  initialPreferences: ApplicationPreferencesV1
  persistenceState: PreferencesPersistenceState
  persistenceError?: string
  storageInitializationReady: boolean
}>()

type SettingsValues = {
  editor: EditorSettings
  toolbar: ToolbarPreferences
}

// 本文は CodeMirror、設定はVueの現在値を正本とし、設定更新は明示保存経路へ集約する。
const editor = ref<EditorHandle | null>(null)
const path = ref<string | null>(null)
const documentOrigin = ref<{ nodeId: number; projectId: number } | null>(null)
const savedText = ref('')
const dirty = ref(false)
const statistics = ref(createEmptyStatistics())
const busy = ref(true)
const documentLocked = ref(true)
const currentFile = ref<TextFile | null>(null)
const documentFormat = ref<{ lineEnding: LineEnding; hasBom: boolean }>({ lineEnding: '\n', hasBom: false })
const suggestedFileName = ref('無題.txt')
const restoredUnsaved = ref(false)
const maximized = ref(false)
const alwaysOnTop = ref(false)
const openMenu = ref<'file' | 'edit' | 'settings' | 'display' | 'window' | null>(null)
const settingsSubmenuOpen = ref(false)
const appWindow = getCurrentWindow()
const editorSettings = ref<EditorSettings>({ ...props.initialPreferences.editor })
const toolbarPreferences = ref<ToolbarPreferences>({
  visible: props.initialPreferences.ui.toolbar.visible,
  items: props.initialPreferences.ui.toolbar.items.map((item) => ({ ...item })),
})
const projectTreeWidth = ref(props.initialPreferences.ui.projectTree.width)
const projectTreeDetached = ref(props.initialPreferences.ui.projectTree.detached)
const mainViewportWidth = ref(window.innerWidth)
const expandedProjectTreeFolderIds = ref<number[]>([])
const projectTreeUnavailableNodeIds = ref<number[]>([])
const projectTreeOpenResult = ref<ProjectTreeOpenResult | null>(null)
const projectTreeWindowDisabled = computed(() => busy.value || mainCloseInProgress.value)
const projectTreeMaximumWidth = computed(() => Math.max(220, Math.min(480, mainViewportWidth.value - 320)))
const projectTreeDisplayWidth = computed(() => Math.min(projectTreeWidth.value, projectTreeMaximumWidth.value))
const displayedToolbarItems = computed(() => toolbarPreferences.value.items)
const displayedToolbarVisible = computed(() => toolbarPreferences.value.visible)
const displayMenuOpen = computed({
  get: (): boolean => openMenu.value === 'display',
  set: (value: boolean): void => {
    openMenu.value = value ? 'display' : (openMenu.value === 'display' ? null : openMenu.value)
  },
})
const settingsWindowOpen = ref(false)
const settingsPage = ref<SettingsViewId>('editor.wrapping')
const toolbarContextMenuOpen = ref(false)
const toolbarContextMenuTarget = ref<[number, number]>([0, 0])
const persistenceNotice = ref('')
const persistenceNoticeOpen = ref(false)
const fileMenuOpen = computed({
  get: (): boolean => openMenu.value === 'file',
  set: (value: boolean): void => {
    openMenu.value = value ? 'file' : (openMenu.value === 'file' ? null : openMenu.value)
  },
})
const editMenuOpen = computed({
  get: (): boolean => openMenu.value === 'edit',
  set: (value: boolean): void => {
    openMenu.value = value ? 'edit' : (openMenu.value === 'edit' ? null : openMenu.value)
  },
})
const settingsMenuOpen = computed({
  get: (): boolean => openMenu.value === 'settings',
  set: (value: boolean): void => {
    if (!value) settingsSubmenuOpen.value = false
    openMenu.value = value ? 'settings' : (openMenu.value === 'settings' ? null : openMenu.value)
  },
})
const windowMenuOpen = computed({
  get: (): boolean => openMenu.value === 'window',
  set: (value: boolean): void => {
    openMenu.value = value ? 'window' : (openMenu.value === 'window' ? null : openMenu.value)
  },
})
// 保存先が未定なら、上部には新規文書の名前を表示する。
const displayName = computed(() => path.value ? fileName(path.value) : restoredUnsaved.value ? suggestedFileName.value : '無題')
let recoveryReady = false
let recoveryTimer: ReturnType<typeof setTimeout> | undefined
let recoveryErrorReported = false
let unlistenClose: (() => void) | undefined
let unlistenResize: (() => void) | undefined
let unlistenSettingsCommand: (() => void) | undefined
let settingsWindowOpening = false
let settingsWindow: WebviewWindow | null = null
let settingsSaveTimer: ReturnType<typeof setTimeout> | undefined
let settingsSavePromise: Promise<void> | null = null
let flushAfterCurrentSave = false
let trailingSaveDue = false
let settingsChangeRevision = 0
let persistedSettingsRevision = 0
let settingsStateRevision = 0
let lastPersistedSettings = cloneSettings(editorSettings.value, toolbarPreferences.value)
let settingsHistoryActive = false
const settingsUndoHistory: SettingsValues[] = []
const settingsRedoHistory: SettingsValues[] = []
const settingsHistoryLimit = 100
const mainCloseInProgress = ref(false)
const searchSession = new SearchSession()
let searchWindow: WebviewWindow | null = null
let searchWindowOpening = false
let searchWindowReady = false
let searchWindowClosing = false
let searchStatus: SearchStatus = 'empty'
let searchStateRevision = 0
let searchWindowError = ''
let searchFocus = { field: 'search' as SearchField, revision: 0 }
let unlistenSearchCommand: (() => void) | undefined
let unlistenProjectTreeCommand: (() => void) | undefined
let unlistenViewportResize: (() => void) | undefined
let projectTreeWindow: WebviewWindow | null = null
let projectTreeWindowId = ''
let projectTreeWindowOpeningPromise: Promise<boolean> | null = null
let projectTreeWindowClosePromise: Promise<void> | null = null
let projectTreeWindowClosingForDock = false
let projectTreeWindowClosingForExit = false
let projectTreeWindowStateRevision = 0
let projectTreeSaveTimer: ReturnType<typeof setTimeout> | undefined
let projectTreeSavePromise = Promise.resolve()
let projectTreeResizeStart: { pointerId: number; startX: number; startWidth: number } | null = null

watch(documentLocked, (locked) => {
  searchSession.setLocked(locked)
  void publishSearchState()
}, { flush: 'sync' })

watch([busy, documentLocked, documentOrigin, mainCloseInProgress], () => {
  void publishProjectTreeWindowState()
}, { deep: true })

const commandActions: Record<CommandId, () => Promise<void>> = {
  'document.new': newDocument,
  'document.open': openDocument,
  'document.save': saveDocument,
  'document.saveAs': saveDocumentAs,
  'edit.find': () => openSearchWindow('search'),
  'edit.replace': () => openSearchWindow('replace'),
  'settings.open': openSettingsWindow,
  'wrap.window': () => chooseWrapMode('window'),
  'wrap.columns': () => chooseWrapMode('columns'),
  'wrap.none': () => chooseWrapMode('none'),
  'window.minimize': minimizeWindow,
  'window.maximize': maximizeWindow,
  'window.maximizeVertical': () => maximizeWindowAxis('vertical'),
  'window.maximizeHorizontal': () => maximizeWindowAxis('horizontal'),
  'window.alwaysOnTop': toggleAlwaysOnTop,
  'window.close': closeWindow,
  'view.toolbar.toggle': toggleToolbarVisibility,
  'view.toolbar.customize': async () => openSettingsWindow('appearance.toolbar'),
}
const appCommands = Object.fromEntries(appCommandDefinitions.map((definition) => [definition.id, {
  ...definition,
  execute: commandActions[definition.id],
  isEnabled: () => !isCommandDisabled(definition.id),
  isChecked: () => isCommandChecked(definition.id),
}])) as Record<CommandId, AppCommand>

/** CodeMirrorの本文変更だけから未保存状態を判定する。統計・選択の通知は関与しない。 */
function onChange(text: string): void {
  dirty.value = restoredUnsaved.value || text !== savedText.value
  scheduleRecoverySave()
}

/** 古い本文に対する遅延処理を取り消し、文書切り替え後に復元候補が復活しないようにする。 */
function cancelRecoveryTimer(): void {
  if (recoveryTimer) clearTimeout(recoveryTimer)
  recoveryTimer = undefined
}

/** 入力が1秒止まった時点で最新本文を保護し、Undo等で保存済みに戻った場合は候補を削除する。 */
function scheduleRecoverySave(): void {
  if (!recoveryReady) return
  cancelRecoveryTimer()
  if (!dirty.value) {
    void syncRecoverySnapshot()
    return
  }
  recoveryTimer = setTimeout(() => {
    recoveryTimer = undefined
    void syncRecoverySnapshot()
  }, 1000)
}

/** 現在の未保存本文、または候補の削除を直列Storeへ渡す。失敗は編集を妨げず通知する。 */
async function syncRecoverySnapshot(): Promise<void> {
  if (!recoveryReady) return
  cancelRecoveryTimer()
  try {
    await saveRecoverySnapshot(dirty.value ? {
      schemaVersion: 1,
      text: editor.value?.getText() ?? '',
      fileName: path.value ? fileName(path.value) : suggestedFileName.value,
      ...documentFormat.value,
      updatedAt: new Date().toISOString(),
    } : null)
    recoveryErrorReported = false
  } catch (error) {
    if (!recoveryErrorReported) {
      showPersistenceNotice(`復元データを更新できません。本文を通常の保存で保護してください。${String(error)}`)
      recoveryErrorReported = true
    }
  }
}

/** 復元候補を確認し、保存先を持たない未保存文書として開く。空の本文でも明示保存までは未保存を維持する。 */
async function initializeRecovery(): Promise<boolean> {
  let unresolvedSnapshot = false
  let recoveryLoaded = false
  try {
    const snapshot = await loadRecoverySnapshot()
    recoveryLoaded = true
    if (snapshot) {
      unresolvedSnapshot = true
      const restore = await ask(`前回の未保存の本文があります。復元しますか？\n${snapshot.fileName}\n${new Date(snapshot.updatedAt).toLocaleString('ja-JP')}`, {
        title: '本文の復元',
        kind: 'warning',
        okLabel: '復元',
        cancelLabel: '破棄',
      })
      unresolvedSnapshot = false
      if (restore) {
        suggestedFileName.value = snapshot.fileName
        documentFormat.value = { lineEnding: snapshot.lineEnding, hasBom: snapshot.hasBom }
        restoredUnsaved.value = true
        editor.value?.setDocument(snapshot.text)
      } else {
        await saveRecoverySnapshot(null)
      }
    }
  } catch (error) {
    showPersistenceNotice(unresolvedSnapshot
      ? `復元の確認ができませんでした。前回の候補を保護するため、今回は復元データの自動保存を停止します。${String(error)}`
      : `復元データを読み込めませんでした。${String(error)}`)
  } finally {
    recoveryReady = !unresolvedSnapshot
    busy.value = false
    documentLocked.value = false
    editor.value?.focus()
  }
  return recoveryLoaded
}

/** 未保存の変更を破棄してよいか確認し、続行できる場合に true を返す。確認ダイアログを開く。 */
async function confirmDiscard(): Promise<boolean> {
  if (!dirty.value) return true
  return ask('未保存の変更があります。破棄して続けますか？', {
    title: '小説エディタ',
    kind: 'warning',
  })
}

/** 操作名と発生した例外を利用者へ示す。Tauri のエラーダイアログを開く。 */
async function showError(action: string, error: unknown): Promise<void> {
  await message(`${action}に失敗しました。\n${String(error)}`, {
    title: '小説エディタ',
    kind: 'error',
  })
}

/** 永続化に関する状態を一時通知として表示する。 */
function showPersistenceNotice(text: string): void {
  persistenceNotice.value = text
  persistenceNoticeOpen.value = true
}

/** 設定ウィンドウへの保存エラー通知をbest-effortで送り、ウィンドウ終了競合を無視する。 */
async function publishSettingsError(detail: string): Promise<void> {
  try {
    if (!await WebviewWindow.getByLabel('settings')) return
    await emitTo('settings', SETTINGS_ERROR_EVENT, detail)
  } catch {
    // メイン画面の通知を維持し、設定ウィンドウへの通知失敗は保存状態へ波及させない。
  }
}

/** 必要なら破棄を確認して新規文書へ切り替え、保存先と編集履歴を初期化する。 */
async function newDocument(): Promise<void> {
  if (busy.value || mainCloseInProgress.value) return
  busy.value = true
  documentLocked.value = true
  try {
    if (!(await confirmDiscard())) return
    cancelRecoveryTimer()
    path.value = null
    documentOrigin.value = null
    currentFile.value = null
    documentFormat.value = { lineEnding: '\n', hasBom: false }
    suggestedFileName.value = '無題.txt'
    restoredUnsaved.value = false
    savedText.value = ''
    editor.value?.setDocument('')
    await syncRecoverySnapshot()
    editor.value?.focus()
  } catch (error) {
    await showError('新規作成', error)
  } finally {
    busy.value = false
    documentLocked.value = false
  }
}

/** 選択した TXT を読み込み、本文・保存先・未保存判定の基準を更新する。選択取消時は現状を保つ。 */
async function openDocument(): Promise<void> {
  if (busy.value || mainCloseInProgress.value) return
  busy.value = true
  documentLocked.value = true
  try {
    const selected = await chooseTextFile()
    if (!selected) return
    const file = await loadTextFile(selected)
    if (!(await confirmDiscard())) return
    cancelRecoveryTimer()
    documentOrigin.value = null
    currentFile.value = file
    path.value = file.path
    documentFormat.value = { lineEnding: file.lineEnding, hasBom: file.hasBom }
    suggestedFileName.value = fileName(file.path)
    restoredUnsaved.value = false
    editor.value?.setDocument(file.text)
    // CodeMirror は改行を内部表現へ揃えるため、未保存判定の基準も読み込み後の本文に合わせる。
    file.editorText = editor.value?.getText() ?? file.text
    savedText.value = file.editorText
    dirty.value = false
    await syncRecoverySnapshot()
    editor.value?.focus()
  } catch (error) {
    await showError('ファイルを開く操作', error)
  } finally {
    busy.value = false
    documentLocked.value = false
  }
}

/** ツリーの要求元を問わず、メイン画面で許可した登録ファイルを本文へ開く。 */
async function openProjectTreeFile(request: ProjectTreeOpenRequest, sourceWindowId?: string): Promise<void> {
  if (busy.value || mainCloseInProgress.value) {
    reportProjectTreeOpenResult({ requestId: request.requestId, nodeId: request.nodeId, error: '別の操作中のため、ファイルを開けませんでした。' }, sourceWindowId)
    return
  }
  busy.value = true
  documentLocked.value = true
  let unavailable = false
  try {
    const snapshot = await loadProjectTreeSnapshot()
    const node = snapshot.nodes.find((item) => item.id === request.nodeId)
    if (!node || node.kind !== 'file' || node.projectId !== request.projectId) {
      unavailable = true
      throw new Error('選択した登録ファイルは既に変更されています。')
    }
    let authorizedPath: string
    try {
      authorizedPath = await authorizeProjectFile(request.nodeId)
    } catch (error) {
      unavailable = true
      throw error
    }
    const file = await loadTextFile(authorizedPath)
    if (!(await confirmDiscard())) {
      reportProjectTreeOpenResult({ requestId: request.requestId, nodeId: request.nodeId }, sourceWindowId)
      return
    }
    cancelRecoveryTimer()
    currentFile.value = file
    path.value = file.path
    documentOrigin.value = { nodeId: request.nodeId, projectId: request.projectId }
    documentFormat.value = { lineEnding: file.lineEnding, hasBom: file.hasBom }
    suggestedFileName.value = fileName(file.path)
    restoredUnsaved.value = false
    editor.value?.setDocument(file.text)
    file.editorText = editor.value?.getText() ?? file.text
    savedText.value = file.editorText
    dirty.value = false
    await syncRecoverySnapshot()
    editor.value?.focus()
    reportProjectTreeOpenResult({ requestId: request.requestId, nodeId: request.nodeId }, sourceWindowId)
  } catch (error) {
    reportProjectTreeOpenResult({
      requestId: request.requestId,
      nodeId: request.nodeId,
      error: String(error),
      unavailable,
    }, sourceWindowId)
  } finally {
    busy.value = false
    documentLocked.value = false
  }
}

/** 開く操作の成否を元のツリーへ返し、参照切れ表示と既存エラー通知を維持する。 */
function reportProjectTreeOpenResult(result: ProjectTreeOpenResult, sourceWindowId?: string): void {
  const unavailable = new Set(projectTreeUnavailableNodeIds.value)
  if (result.error && result.unavailable) unavailable.add(result.nodeId)
  else if (!result.error) unavailable.delete(result.nodeId)
  updateProjectTreeUnavailableNodeIds([...unavailable], false)
  projectTreeOpenResult.value = result
  if (sourceWindowId && sourceWindowId === projectTreeWindowId && projectTreeWindow) {
    const requestWindowId = sourceWindowId
    void publishProjectTreeWindowState(result).then((published) => {
      if (published || requestWindowId !== projectTreeWindowId || !projectTreeWindow
        || projectTreeWindowClosingForDock || projectTreeWindowClosingForExit) return
      if (projectTreeOpenResult.value?.requestId === result.requestId) projectTreeOpenResult.value = null
      const detail = result.error
        ? `ファイル操作の結果を分離ツリーへ伝えられませんでした。${result.error}`
        : 'ファイル操作の結果を分離ツリーへ伝えられませんでした。'
      showPersistenceNotice(`${detail} メイン画面へ戻します。`)
      void dockProjectTreeWindow()
    })
  }
}

/** 最新のツリー幅と分離状態を設定Storeへ直列保存する。 */
function persistProjectTreePreferences(): Promise<void> {
  projectTreeSavePromise = projectTreeSavePromise.catch(() => undefined).then(async () => {
    try {
      await saveProjectTreePreferences({ width: projectTreeWidth.value, detached: projectTreeDetached.value })
    } catch (error) {
      showPersistenceNotice(`プロジェクトツリーの表示設定を保存できません。${String(error)}`)
    }
  })
  return projectTreeSavePromise
}

/** 連続した幅変更をまとめ、最後の位置だけを保存する。 */
function scheduleProjectTreePreferencesSave(): void {
  if (projectTreeSaveTimer) clearTimeout(projectTreeSaveTimer)
  projectTreeSaveTimer = setTimeout(() => {
    projectTreeSaveTimer = undefined
    void persistProjectTreePreferences()
  }, 250)
}

/** 終了前に遅延中の表示設定保存を完了させる。 */
async function flushProjectTreePreferences(): Promise<void> {
  if (projectTreeSaveTimer) {
    clearTimeout(projectTreeSaveTimer)
    projectTreeSaveTimer = undefined
    await persistProjectTreePreferences()
  } else {
    await projectTreeSavePromise
  }
}

/** 画面幅と本文の最低幅に合わせてツリー幅を更新し、設定保存を予約する。 */
function setProjectTreeWidth(width: number): void {
  projectTreeWidth.value = Math.max(220, Math.min(projectTreeMaximumWidth.value, Math.round(width)))
  scheduleProjectTreePreferencesSave()
}

/** メインウィンドウの実幅を取り直し、本文の最小幅を保つ表示上限を更新する。 */
function updateMainViewportWidth(): void {
  mainViewportWidth.value = window.innerWidth
}

/** メインに表示中のツリーから受け取った展開状態を分離時の引き継ぎ値にする。 */
function updateExpandedProjectTreeFolders(nodeIds: number[]): void {
  expandedProjectTreeFolderIds.value = normalizeProjectTreeNodeIds(nodeIds)
}

/** 参照切れノードの状態を保持し、ドック後のツリーへ引き継ぐ。 */
function updateProjectTreeUnavailableNodeIds(nodeIds: number[], publishChild = true): boolean {
  const normalized = normalizeProjectTreeNodeIds(nodeIds)
  const current = projectTreeUnavailableNodeIds.value
  if (current.length === normalized.length && current.every((nodeId, index) => nodeId === normalized[index])) return false
  projectTreeUnavailableNodeIds.value = normalized
  if (publishChild && projectTreeDetached.value) void publishProjectTreeWindowState()
  return true
}

/** 開く結果を一時イベントとして消費し、古い失敗状態の再適用を防ぐ。 */
function consumeProjectTreeOpenResult(requestId: string): void {
  if (projectTreeOpenResult.value?.requestId !== requestId) return
  projectTreeOpenResult.value = null
  if (projectTreeDetached.value) void publishProjectTreeWindowState()
}

/** マウスで境界をドラッグした開始幅と位置を記録する。 */
function startProjectTreeResize(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  projectTreeResizeStart = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: projectTreeDisplayWidth.value,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

/** ポインター移動量をドック幅へ反映する。 */
function moveProjectTreeResize(event: PointerEvent): void {
  if (projectTreeResizeStart?.pointerId !== event.pointerId) return
  setProjectTreeWidth(projectTreeResizeStart.startWidth + event.clientX - projectTreeResizeStart.startX)
}

/** ドラッグを終了し、幅保存の遅延タイマーを確定する。 */
function endProjectTreeResize(event: PointerEvent): void {
  if (projectTreeResizeStart?.pointerId !== event.pointerId) return
  projectTreeResizeStart = null
  scheduleProjectTreePreferencesSave()
}

/** 左右キーと Home/End でツリー幅を調整する。 */
function onProjectTreeResizeKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowLeft') setProjectTreeWidth(projectTreeDisplayWidth.value - 16)
  else if (event.key === 'ArrowRight') setProjectTreeWidth(projectTreeDisplayWidth.value + 16)
  else if (event.key === 'Home') setProjectTreeWidth(220)
  else if (event.key === 'End') setProjectTreeWidth(projectTreeMaximumWidth.value)
  else return
  event.preventDefault()
}

/** メイン画面の状態とツリーの展開状態を、識別子付きで分離ウィンドウへ送る。 */
async function publishProjectTreeWindowState(openResult = projectTreeOpenResult.value): Promise<boolean> {
  const windowId = projectTreeWindowId
  if (!windowId || !projectTreeWindow || projectTreeWindowClosingForDock || projectTreeWindowClosingForExit) return false
  const state: ProjectTreeWindowState = {
    windowId,
    revision: ++projectTreeWindowStateRevision,
    disabled: projectTreeWindowDisabled.value,
    documentOrigin: documentOrigin.value ? { ...documentOrigin.value } : null,
    expandedFolderIds: [...expandedProjectTreeFolderIds.value],
    unavailableNodeIds: [...projectTreeUnavailableNodeIds.value],
    ...(openResult ? { openResult } : {}),
  }
  try {
    await emitTo('project-tree', PROJECT_TREE_WINDOW_STATE_EVENT, state)
    return true
  } catch (error) {
    if (windowId === projectTreeWindowId) {
      showPersistenceNotice(`分離したプロジェクトツリーへ状態を送れません。${String(error)}`)
    }
    return false
  }
}

/** 分離中の操作をウィンドウIDで検査し、現在の子ウィンドウ要求だけを処理する。 */
function handleProjectTreeWindowCommand(command: ProjectTreeWindowCommand): void {
  if (!command || command.windowId !== projectTreeWindowId || !projectTreeWindow || !projectTreeDetached.value) return
  if (command.type === 'ready') {
    void publishProjectTreeWindowState()
  } else if (command.type === 'dock') {
    if (command.expandedFolderIds) expandedProjectTreeFolderIds.value = normalizeProjectTreeNodeIds(command.expandedFolderIds)
    if (command.unavailableNodeIds) updateProjectTreeUnavailableNodeIds(command.unavailableNodeIds, false)
    void dockProjectTreeWindow()
  } else if (command.type === 'expanded-change') {
    expandedProjectTreeFolderIds.value = normalizeProjectTreeNodeIds(command.nodeIds)
    void publishProjectTreeWindowState()
  } else if (command.type === 'unavailable-change') {
    if (updateProjectTreeUnavailableNodeIds(command.nodeIds, false)) void publishProjectTreeWindowState()
  } else if (command.type === 'origin-detached') {
    detachDocumentOrigin(command.nodeId)
  } else if (command.type === 'open-file') {
    void openProjectTreeFile(command.request, command.windowId)
  } else if (command.type === 'open-result-applied') {
    consumeProjectTreeOpenResult(command.requestId)
  }
}

/** 不正な値や重複 ID を除き、展開中フォルダーの同期値を正規化する。 */
function normalizeProjectTreeNodeIds(nodeIds: number[]): number[] {
  return [...new Set(nodeIds.filter((nodeId) => Number.isSafeInteger(nodeId) && nodeId > 0))]
}

/** 分離ウィンドウを一つだけ作成し、生成失敗時はメイン画面表示へ戻す。 */
async function openProjectTreeWindow(): Promise<boolean> {
  if (projectTreeWindowClosePromise) {
    try {
      await projectTreeWindowClosePromise
    } catch {
      // 破棄に失敗した場合は、残っている子ウィンドウを前面へ戻す。
    }
  }
  if (projectTreeWindow) {
    try {
      await projectTreeWindow.setFocus()
    } catch (error) {
      showPersistenceNotice(`分離したプロジェクトツリーへ切り替えられません。${String(error)}`)
    }
    return true
  }
  if (projectTreeWindowOpeningPromise) return projectTreeWindowOpeningPromise

  const opening = createProjectTreeWindow()
  projectTreeWindowOpeningPromise = opening
  try {
    return await opening
  } finally {
    if (projectTreeWindowOpeningPromise === opening) projectTreeWindowOpeningPromise = null
  }
}

/** 分離ウィンドウの生成イベントを登録し、成功・失敗を呼び出し元へ返す。 */
function createProjectTreeWindow(): Promise<boolean> {
  projectTreeWindowId = crypto.randomUUID()
  projectTreeWindowStateRevision = 0
  const windowId = projectTreeWindowId
  return new Promise((resolve) => {
    try {
      const createdWindow = new WebviewWindow('project-tree', {
        url: `project-tree.html?windowId=${encodeURIComponent(windowId)}`,
        title: 'プロジェクトツリー',
        parent: 'main',
        width: Math.max(320, projectTreeDisplayWidth.value + 40),
        height: 720,
        minWidth: 260,
        minHeight: 360,
        resizable: true,
        decorations: true,
        dragDropEnabled: false,
      })
      projectTreeWindow = createdWindow
      void createdWindow.once('tauri://created', () => {
        if (projectTreeWindowId !== windowId) return
        projectTreeDetached.value = true
        scheduleProjectTreePreferencesSave()
        void publishProjectTreeWindowState()
        resolve(true)
      })
      void createdWindow.once('tauri://error', (event) => {
        if (projectTreeWindowId === windowId) {
          projectTreeWindow = null
          projectTreeWindowId = ''
          projectTreeDetached.value = false
          scheduleProjectTreePreferencesSave()
          showPersistenceNotice(`分離ウィンドウを作成できないため、ツリーをメイン画面に表示します。${String(event.payload)}`)
        }
        resolve(false)
      })
      void createdWindow.once('tauri://destroyed', () => handleProjectTreeWindowDestroyed(createdWindow))
    } catch (error) {
      projectTreeWindow = null
      projectTreeWindowId = ''
      projectTreeDetached.value = false
      scheduleProjectTreePreferencesSave()
      showPersistenceNotice(`分離ウィンドウを作成できないため、ツリーをメイン画面に表示します。${String(error)}`)
      resolve(false)
    }
  })
}

/** ボタンまたは子ウィンドウの×から分離窓を閉じ、展開状態を保ってドックへ戻す。 */
async function dockProjectTreeWindow(): Promise<void> {
  if (!projectTreeDetached.value && !projectTreeWindow) return
  projectTreeDetached.value = false
  scheduleProjectTreePreferencesSave()
  const closingWindow = projectTreeWindow
  if (!closingWindow) return

  projectTreeWindowClosingForDock = true
  const closing = closingWindow.destroy().then(() => undefined)
  projectTreeWindowClosePromise = closing
  try {
    await closing
  } catch (error) {
    projectTreeDetached.value = projectTreeWindow === closingWindow
    projectTreeWindowClosingForDock = false
    scheduleProjectTreePreferencesSave()
    await showError('プロジェクトツリーを戻す操作', error)
  } finally {
    if (projectTreeWindow === closingWindow && !projectTreeDetached.value) {
      projectTreeWindow = null
      projectTreeWindowId = ''
      projectTreeWindowClosingForDock = false
    }
    projectTreeWindowClosePromise = null
  }
}

/** 予期しない子ウィンドウ終了をドッキング扱いにし、終了処理中は設定を維持する。 */
function handleProjectTreeWindowDestroyed(destroyedWindow: WebviewWindow): void {
  if (projectTreeWindow !== destroyedWindow) return
  projectTreeWindow = null
  projectTreeWindowId = ''
  if (projectTreeWindowClosingForDock) {
    projectTreeWindowClosingForDock = false
    return
  }
  if (projectTreeWindowClosingForExit) return
  if (projectTreeDetached.value) {
    projectTreeDetached.value = false
    scheduleProjectTreePreferencesSave()
    showPersistenceNotice('分離したプロジェクトツリーが閉じたため、メイン画面へ戻しました。')
  }
}

/** メイン画面の終了時に子窓も閉じ、分離設定は次回起動用に保持する。 */
async function closeProjectTreeWindowForExit(): Promise<void> {
  if (projectTreeWindowOpeningPromise) await projectTreeWindowOpeningPromise
  const closingWindow = projectTreeWindow
  if (!closingWindow) return
  projectTreeWindowClosingForExit = true
  try {
    await closingWindow.destroy()
    if (projectTreeWindow === closingWindow) {
      projectTreeWindow = null
      projectTreeWindowId = ''
    }
  } catch (error) {
    projectTreeWindowClosingForExit = false
    throw error
  }
}

/** 分離設定を復元する起動時とボタン操作の両方で、作成失敗を画面内通知する。 */
async function requestProjectTreeDetach(): Promise<void> {
  await openProjectTreeWindow()
}

/** 登録解除や参照先変更後も、開いている本文を維持してノード出自だけを解除する。 */
function detachDocumentOrigin(nodeId: number): void {
  if (documentOrigin.value?.nodeId === nodeId) documentOrigin.value = null
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
  if (busy.value || mainCloseInProgress.value) return
  busy.value = true
  try {
    const target = !saveAs && path.value ? path.value : await chooseSavePath(path.value ?? suggestedFileName.value)
    if (!target) return
    const previousPath = path.value
    const text = editor.value?.getText() ?? ''
    const { lineEnding, hasBom } = documentFormat.value
    const savedFile = await saveTextFile(target, text, lineEnding, hasBom, currentFile.value ?? undefined)
    path.value = target
    if (previousPath !== target) documentOrigin.value = null
    currentFile.value = savedFile
    suggestedFileName.value = fileName(target)
    restoredUnsaved.value = false
    savedText.value = text
    // 書き込み中にも編集できるので、保存開始時の本文と現在の本文を改めて比較する。
    dirty.value = (editor.value?.getText() ?? '') !== text
    await syncRecoverySnapshot()
  } catch (error) {
    await showError('保存', error)
  } finally {
    busy.value = false
  }
}

/** ウィンドウの最大化状態を取得し、タイトルバーのボタン表示を更新する。 */
async function updateMaximized(): Promise<void> {
  maximized.value = await appWindow.isMaximized()
}

/** メニュー項目から共通コマンドを実行する。 */
function runMenuCommand(commandId: CommandId): void {
  openMenu.value = null
  settingsSubmenuOpen.value = false
  executeCommand(commandId)
}

/** メニュー、ショートカット、ツールバーで共有するコマンドを実行する。 */
function executeCommand(commandId: CommandId): void {
  const command = appCommands[commandId]
  if (!command.isEnabled()) return
  void command.execute()
}

/** 文書処理中に利用できないコマンドを判定する。 */
function isCommandDisabled(commandId: CommandId): boolean {
  if (mainCloseInProgress.value) return true
  if (commandId === 'edit.find' || commandId === 'edit.replace') return documentLocked.value
  return busy.value && commandId.startsWith('document.')
}

/** 現在選択されている状態付きコマンドかを判定する。 */
function isCommandChecked(commandId: CommandId): boolean {
  if (commandId === 'wrap.window') return editorSettings.value.wrapMode === 'window'
  if (commandId === 'wrap.columns') return editorSettings.value.wrapMode === 'columns'
  if (commandId === 'wrap.none') return editorSettings.value.wrapMode === 'none'
  return commandId === 'window.alwaysOnTop' && alwaysOnTop.value
}

/** コマンドIDから表示情報を取得する。 */
function getCommandLabel(commandId: CommandId): string {
  return appCommands[commandId].label
}

/** コマンド定義からショートカット表記を取得する。 */
function getCommandShortcut(commandId: CommandId): string | undefined {
  return appCommands[commandId].shortcut
}

/** 右クリック位置へツールバーの操作メニューを開く。 */
function openToolbarContextMenu(event: MouseEvent): void {
  event.preventDefault()
  openMenu.value = null
  settingsSubmenuOpen.value = false
  toolbarContextMenuTarget.value = [event.clientX, event.clientY]
  toolbarContextMenuOpen.value = true
}

/** 状態配信をbest-effortで行い、閉じかけの設定ウィンドウで保存処理を止めない。 */
async function publishSettingsState(): Promise<void> {
  try {
    if (!await WebviewWindow.getByLabel('settings')) return
    const snapshot: SettingsSnapshot = {
      editor: { ...editorSettings.value },
      toolbar: cloneToolbarPreferences(toolbarPreferences.value),
      page: settingsPage.value,
      history: {
        canUndo: settingsUndoHistory.length > 0,
        canRedo: settingsRedoHistory.length > 0,
      },
      revision: ++settingsStateRevision,
    }
    await emitTo('settings', SETTINGS_STATE_EVENT, snapshot)
  } catch {
    // ウィンドウの破棄と競合した状態配信は永続化処理に影響させない。
  }
}

/** エディター設定とツールバー設定を分離せず複製する。 */
function cloneSettings(editorValue: EditorSettings, toolbarValue: ToolbarPreferences): SettingsValues {
  return {
    editor: { ...editorValue },
    toolbar: cloneToolbarPreferences(toolbarValue),
  }
}

/** ツールバー設定を別画面へ渡す際の参照共有を避ける。 */
function cloneToolbarPreferences(value: ToolbarPreferences): ToolbarPreferences {
  return { visible: value.visible, items: value.items.map((item) => ({ ...item })) }
}

/** 設定変更を250msまとめて保存し、頻繁な連続操作によるStore書き込みを抑える。 */
function scheduleSettingsSave(): void {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = undefined
    requestSettingsFlush()
  }, 250)
  void publishSettingsState()
}

/** 自動保存を開始し、予期しない内部例外も通知して未処理Promiseにしない。 */
function requestSettingsFlush(immediate = false): void {
  void flushSettingsSave(immediate).catch((error: unknown) => {
    showPersistenceNotice(`設定の保存処理に失敗しました。${String(error)}`)
  })
}

/** 現在値を即時反映し、変更があれば末尾デバウンスまたは即時保存を予約する。 */
function updateCurrentSettings(
  editorPatch?: Partial<EditorSettings>,
  toolbarPatch?: Partial<ToolbarPreferences>,
  flushImmediately = false,
  recordHistory = true,
): void {
  const nextEditor = normalizeEditorSettings({ ...editorSettings.value, ...editorPatch })
  const nextToolbar = {
    ...toolbarPreferences.value,
    ...toolbarPatch,
    items: toolbarPatch?.items
      ? normalizeToolbarItems(toolbarPatch.items)
      : toolbarPreferences.value.items.map((item) => ({ ...item })),
  }
  const hasChanged = JSON.stringify(nextEditor) !== JSON.stringify(editorSettings.value) ||
    JSON.stringify(nextToolbar) !== JSON.stringify(toolbarPreferences.value)
  if (!hasChanged) {
    if (flushImmediately) requestSettingsFlush(true)
    return
  }

  if (recordHistory && settingsHistoryActive) {
    settingsUndoHistory.push(cloneSettings(editorSettings.value, toolbarPreferences.value))
    if (settingsUndoHistory.length > settingsHistoryLimit) settingsUndoHistory.shift()
    settingsRedoHistory.length = 0
  }
  editorSettings.value = nextEditor
  toolbarPreferences.value = nextToolbar
  settingsChangeRevision += 1
  scheduleSettingsSave()
  if (flushImmediately) requestSettingsFlush(true)
}

/** 設定ウィンドウの表示中だけ使うUndo履歴を新しく開始する。 */
function beginSettingsHistorySession(): void {
  clearSettingsHistory()
  settingsHistoryActive = true
}

/** Undo／Redoの両履歴を空にし、現在の設定状態にそろえる。 */
function clearSettingsHistory(): void {
  settingsUndoHistory.length = 0
  settingsRedoHistory.length = 0
}

/** 設定ウィンドウ終了時に履歴セッションを破棄する。 */
function endSettingsHistorySession(): void {
  settingsHistoryActive = false
  clearSettingsHistory()
}

/** Undoで直前状態を適用し、現在状態をRedo履歴へ移す。 */
function undoSettingsChange(): void {
  const previous = settingsUndoHistory.pop()
  if (!previous) return

  settingsRedoHistory.push(cloneSettings(editorSettings.value, toolbarPreferences.value))
  updateCurrentSettings(previous.editor, previous.toolbar, false, false)
  void publishSettingsState()
}

/** Redoで取り消した状態を適用し、現在状態をUndo履歴へ移す。 */
function redoSettingsChange(): void {
  const next = settingsRedoHistory.pop()
  if (!next) return

  settingsUndoHistory.push(cloneSettings(editorSettings.value, toolbarPreferences.value))
  updateCurrentSettings(next.editor, next.toolbar, false, false)
  void publishSettingsState()
}

/** 現在値をStoreへ直列保存し、保存中に加わった変更は最新値へまとめて処理する。 */
async function flushSettingsSave(immediate = false): Promise<void> {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer)
    settingsSaveTimer = undefined
  }

  if (settingsSavePromise) {
    if (immediate) flushAfterCurrentSave = true
    else trailingSaveDue = true
    await settingsSavePromise
    return
  }

  if (settingsChangeRevision <= persistedSettingsRevision) {
    await publishSettingsState()
    return
  }

  // 共有PromiseにはStore書き込みだけでなく、状態確定と必要な追随保存も含める。
  const saveCycle = runSettingsSaveSequence(immediate).catch((error: unknown) => {
    restoreLastPersistedSettings(error)
  })
  settingsSavePromise = saveCycle
  try {
    await saveCycle
  } finally {
    if (settingsSavePromise === saveCycle) settingsSavePromise = null
  }
}

/** 保存要求を共有Promise内で完了し、即時要求があれば最新状態まで続けて保存する。 */
async function runSettingsSaveSequence(immediate: boolean): Promise<void> {
  let flushImmediately = immediate

  while (settingsChangeRevision > persistedSettingsRevision) {
    const writeRevision = settingsChangeRevision
    const writeSnapshot = cloneSettings(editorSettings.value, toolbarPreferences.value)
    await runSettingsSaveCycle(writeSnapshot, writeRevision)
    const hasNewerChanges = settingsChangeRevision > persistedSettingsRevision

    if (!hasNewerChanges) {
      flushAfterCurrentSave = false
      trailingSaveDue = false
      await publishSettingsState()
      return
    }

    await publishSettingsState()
    if (flushAfterCurrentSave || (flushImmediately && trailingSaveDue)) {
      flushAfterCurrentSave = false
      trailingSaveDue = false
      flushImmediately = true
      continue
    }

    flushAfterCurrentSave = false
    trailingSaveDue = false
    if (!settingsSaveTimer) scheduleSettingsSave()
    return
  }

  flushAfterCurrentSave = false
  trailingSaveDue = false
  await publishSettingsState()
}

/** Store書き込み失敗時に現在値を直近の保存成功値へ戻し、非同期通知をbest-effortで送る。 */
function restoreLastPersistedSettings(error: unknown): void {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
  settingsSaveTimer = undefined
  editorSettings.value = { ...lastPersistedSettings.editor }
  toolbarPreferences.value = cloneToolbarPreferences(lastPersistedSettings.toolbar)
  settingsChangeRevision += 1
  persistedSettingsRevision = settingsChangeRevision
  flushAfterCurrentSave = false
  trailingSaveDue = false
  clearSettingsHistory()

  const detail = `設定を保存できなかったため、直近の保存内容へ戻しました。${String(error)}`
  showPersistenceNotice(detail)
  if (settingsWindowOpen.value) void publishSettingsError(detail)
  void publishSettingsState()
}

/** Storeへの1回の書き込みを実行し、失敗はrollbackと通知へ変換して解決する。 */
async function runSettingsSaveCycle(
  writeSnapshot: { editor: EditorSettings; toolbar: ToolbarPreferences },
  writeRevision: number,
): Promise<boolean> {
  try {
    await publishSettingsState()
    await saveSettingsPreferences(writeSnapshot.editor, writeSnapshot.toolbar)
    lastPersistedSettings = writeSnapshot
    persistedSettingsRevision = writeRevision
    await publishSettingsState()
    return true
  } catch (error) {
    restoreLastPersistedSettings(error)
    return false
  }
}

/** 設定変更を設定ウィンドウとメイン画面の共通自動保存経路へ送る。 */
async function toggleToolbarVisibility(): Promise<void> {
  updateCurrentSettings(undefined, { visible: !toolbarPreferences.value.visible })
}

/** 設定ウィンドウが閉じても確定済み設定を維持し、進行中の保存を続ける。 */
function handleSettingsWindowDestroyed(destroyedWindow: WebviewWindow): void {
  if (settingsWindow !== destroyedWindow) return
  settingsWindow = null
  settingsWindowOpening = false
  settingsWindowOpen.value = false
  endSettingsHistorySession()
}

/** メニューから選んだ折り返し方法を即時反映し、自動保存へ渡す。 */
async function chooseWrapMode(mode: WrapMode): Promise<void> {
  updateCurrentSettings({ wrapMode: mode })
  if (settingsWindowOpen.value) settingsPage.value = 'editor.wrapping'
  void publishSettingsState()
}

/** 設定画面から受けたページ遷移と型付き更新を処理する。 */
async function handleSettingsCommand(command: SettingsCommand): Promise<void> {
  try {
    if (command.type === 'ready') {
      if (!settingsHistoryActive) beginSettingsHistorySession()
      settingsWindowOpen.value = true
      await publishSettingsState()
    } else if (command.type === 'navigate') {
      settingsPage.value = command.page
      await publishSettingsState()
    } else if (command.type === 'undo') {
      undoSettingsChange()
    } else if (command.type === 'redo') {
      redoSettingsChange()
    } else if (command.type === 'change') {
      updateCurrentSettings(command.editor, command.toolbar, command.flush ?? false)
    }
  } catch (error) {
    await emitTo('settings', SETTINGS_ERROR_EVENT, String(error))
  }
}

/** 設定ウィンドウを開き、指定されたページを表示して前面へ移す。 */
async function openSettingsWindow(page: SettingsPageId = 'editor.wrapping'): Promise<void> {
  settingsPage.value = page
  if (settingsWindowOpening) return
  settingsWindowOpening = true
  try {
    const existing = await WebviewWindow.getByLabel('settings')
    if (existing) {
      settingsWindow = existing
      settingsWindowOpen.value = true
      await publishSettingsState()
      await existing.setFocus()
      settingsWindowOpening = false
      return
    }
    settingsWindowOpen.value = true
    const createdSettingsWindow = new WebviewWindow('settings', {
      url: 'settings.html',
      title: '設定',
      parent: 'main',
      center: true,
      width: 900,
      height: 680,
      minWidth: 700,
      minHeight: 520,
      decorations: true,
      // WindowsのWebView2ではTauriのファイルドロップがHTML5のドラッグ＆ドロップと競合するため無効化する。
      dragDropEnabled: false,
    })
    settingsWindow = createdSettingsWindow
    void createdSettingsWindow.once('tauri://destroyed', () => handleSettingsWindowDestroyed(createdSettingsWindow))
    void createdSettingsWindow.once('tauri://created', () => { settingsWindowOpening = false })
    void createdSettingsWindow.once('tauri://error', (event) => {
      settingsWindowOpening = false
      settingsWindowOpen.value = false
      void showError('設定画面を開く操作', event.payload)
    })
  } catch (error) {
    settingsWindowOpening = false
    settingsWindowOpen.value = false
    await showError('設定画面を開く操作', error)
  }
}

/** 本文の検索結果と操作可否を配信する。revisionで古い配信の到着を区別する。 */
async function publishSearchState(): Promise<void> {
  if (!searchWindowReady || !searchSession.sessionId) return
  const snapshot: SearchSnapshot = {
    sessionId: searchSession.sessionId,
    conditions: { ...searchSession.conditions },
    status: searchStatus,
    locked: documentLocked.value,
    documentRevision: searchSession.documentRevision,
    acknowledgedSequence: searchSession.sequence,
    revision: ++searchStateRevision,
    focus: { ...searchFocus },
    error: searchWindowError,
  }
  try {
    await emitTo('search', SEARCH_STATE_EVENT, snapshot)
  } catch (error) {
    if (searchWindowReady) showPersistenceNotice(`検索画面へ結果を送れません。${String(error)}`)
  }
}

/** 本文が変わった場合も検索結果を更新し、開いている検索画面へ通知する。 */
function onSearchStatus(status: SearchStatus): void {
  searchStatus = status
  void publishSearchState()
}

/** 本文側のF3は条件があればそのまま検索し、未指定なら検索画面を開く。 */
function onSearchNavigate(action: SearchAction): void {
  if (documentLocked.value || mainCloseInProgress.value) return
  if (!searchSession.conditions.search) {
    void openSearchWindow('search')
    return
  }
  editor.value?.runSearch(action)
}

/** 入力と操作を同じ要求として処理し、操作時の条件を非同期の到着順へ依存させない。 */
function handleSearchCommand(command: SearchCommand): void {
  if (!searchWindow || searchWindowClosing || command.sessionId !== searchSession.sessionId) return
  searchWindowError = ''
  if (command.type === 'ready') {
    searchWindowReady = true
    editor.value?.setSearch(searchSession.conditions, true)
  } else {
    const result = searchSession.receive(command)
    if (!result.accepted) return
    editor.value?.setSearch(searchSession.conditions, true)
    if (result.action) editor.value?.runSearch(result.action)
    if (command.type === 'close') {
      void closeSearchWindow().catch((error: unknown) => showError('検索画面を閉じる操作', error))
      return
    }
  }
  void publishSearchState()
}

/** 検索窓の破棄を反映する。条件は残し、通常の終了時だけ本文へフォーカスを戻す。 */
function handleSearchWindowDestroyed(destroyedWindow: WebviewWindow): void {
  if (searchWindow !== destroyedWindow) return
  searchWindow = null
  searchWindowOpening = false
  searchWindowClosing = false
  searchWindowReady = false
  searchSession.stop()
  editor.value?.setSearch(searchSession.conditions, false)
  if (!mainCloseInProgress.value) {
    void appWindow.setFocus().then(() => editor.value?.focus()).catch((error: unknown) => {
      showPersistenceNotice(`本文へフォーカスを戻せません。${String(error)}`)
    })
  }
}

/** メイン側で破棄することで、閉じる直前の入力を確定してから検索窓を終了する。 */
async function closeSearchWindow(): Promise<void> {
  if (!searchWindow) return
  const closingWindow = searchWindow
  searchWindowClosing = true
  try {
    await closingWindow.destroy()
    handleSearchWindowDestroyed(closingWindow)
  } catch (error) {
    searchWindowError = `検索画面を閉じられません。もう一度操作してください。${String(error)}`
    await publishSearchState()
    throw error
  } finally {
    searchWindowClosing = false
  }
}

/** 独立した非モーダル検索窓を1つだけ開き、既存の窓では指定入力へフォーカスする。 */
async function openSearchWindow(field: SearchField): Promise<void> {
  if (documentLocked.value || mainCloseInProgress.value || searchWindowClosing) return
  searchFocus = { field, revision: searchFocus.revision + 1 }
  if (searchWindowOpening) return
  if (searchWindow) {
    try {
      await searchWindow.unminimize()
      await searchWindow.setFocus()
      await publishSearchState()
    } catch (error) {
      await showError('検索画面を開く操作', error)
    }
    return
  }
  searchWindowOpening = true
  searchWindowError = ''
  const sessionId = crypto.randomUUID()
  searchSession.start(sessionId)
  try {
    const createdWindow = new WebviewWindow('search', {
      url: `search.html?session=${encodeURIComponent(sessionId)}`,
      title: '検索・置換',
      parent: 'main',
      center: true,
      width: 640,
      height: 380,
      minWidth: 480,
      minHeight: 340,
      resizable: true,
      decorations: true,
      dragDropEnabled: false,
    })
    searchWindow = createdWindow
    void createdWindow.once('tauri://destroyed', () => handleSearchWindowDestroyed(createdWindow))
    void createdWindow.once('tauri://created', () => { searchWindowOpening = false })
    void createdWindow.once('tauri://error', (event) => {
      handleSearchWindowDestroyed(createdWindow)
      void showError('検索画面を開く操作', event.payload)
    })
  } catch (error) {
    searchWindowOpening = false
    searchSession.stop()
    await showError('検索画面を開く操作', error)
  }
}

/** ウィンドウを最小化する。 */
async function minimizeWindow(): Promise<void> {
  try {
    await appWindow.minimize()
  } catch (error) {
    await showError('ウィンドウの最小化', error)
  }
}

/** 最大化と元のサイズを切り替え、ボタン表示を現在の状態に合わせる。 */
async function toggleMaximizeWindow(): Promise<void> {
  try {
    await appWindow.toggleMaximize()
    await updateMaximized()
  } catch (error) {
    await showError('ウィンドウのサイズ変更', error)
  }
}

/** メニューから通常の最大化を行う。既に最大化されている場合はそのままにする。 */
async function maximizeWindow(): Promise<void> {
  try {
    await appWindow.maximize()
    await updateMaximized()
  } catch (error) {
    await showError('ウィンドウの最大化', error)
  }
}

/** 現在のモニターの作業領域に合わせ、指定方向だけ窓を広げる。 */
async function maximizeWindowAxis(axis: 'vertical' | 'horizontal'): Promise<void> {
  try {
    if (await appWindow.isMaximized()) await appWindow.unmaximize()
    const monitor = await currentMonitor()
    if (!monitor) throw new Error('現在のモニターを取得できませんでした。')

    const [position, outerSize, innerSize] = await Promise.all([
      appWindow.outerPosition(),
      appWindow.outerSize(),
      appWindow.innerSize(),
    ])
    const workArea = monitor.workArea
    // setSize は内側の寸法を指定するため、外側との差を差し引いて作業領域へ合わせる。
    const targetPosition = new PhysicalPosition(
      axis === 'horizontal' ? workArea.position.x : position.x,
      axis === 'vertical' ? workArea.position.y : position.y,
    )
    const targetSize = new PhysicalSize(
      axis === 'horizontal' ? workArea.size.width - (outerSize.width - innerSize.width) : innerSize.width,
      axis === 'vertical' ? workArea.size.height - (outerSize.height - innerSize.height) : innerSize.height,
    )
    await appWindow.setPosition(targetPosition)
    await appWindow.setSize(targetSize)
    await updateMaximized()
  } catch (error) {
    await showError('ウィンドウのサイズ変更', error)
  }
}

/** 現在のウィンドウの最前面表示を切り替え、成功後にチェック表示を更新する。 */
async function toggleAlwaysOnTop(): Promise<void> {
  try {
    await appWindow.setAlwaysOnTop(!alwaysOnTop.value)
    alwaysOnTop.value = await appWindow.isAlwaysOnTop()
  } catch (error) {
    await showError('常に手前に表示', error)
  }
}

/** 通常の終了要求を送り、必要なら文書の破棄確認を経て閉じる。 */
async function closeWindow(): Promise<void> {
  try {
    await appWindow.close()
  } catch (error) {
    await showError('ウィンドウを閉じる操作', error)
  }
}

/** 終了要求で待機中・実行中の保存をすべて完了させる。 */
async function flushAllSettingsChanges(): Promise<void> {
  while (settingsSaveTimer || settingsSavePromise || settingsChangeRevision > persistedSettingsRevision) {
    await flushSettingsSave(true)
  }
}

/** Esc でメニューを閉じ、修飾キーを含む共通ショートカットを処理する。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && settingsSubmenuOpen.value) {
    event.preventDefault()
    settingsSubmenuOpen.value = false
    return
  }
  if (event.key === 'Escape' && openMenu.value) {
    event.preventDefault()
    openMenu.value = null
    return
  }
  const command = findShortcutCommand(event)
  if (command) {
    event.preventDefault()
    executeCommand(command.id)
  }
}

// 画面のマウント時にショートカットと Tauri のウィンドウ終了要求を購読する。
onMounted(async () => {
  window.addEventListener('keydown', onKeydown, true)
  if (props.persistenceState !== 'ready') {
    const detail = props.persistenceError ? ` ${props.persistenceError}` : ''
    showPersistenceNotice(props.persistenceState === 'recovered'
      ? `設定データを読み込めなかったため、初期値で再作成しました。${detail}`
      : `設定を保存できません。今回の変更はアプリ終了後に失われます。${detail}`)
  }
  window.addEventListener('resize', updateMainViewportWidth)
  unlistenViewportResize = () => window.removeEventListener('resize', updateMainViewportWidth)
  // 設定保存と文書終了確認を終えてから、メインウィンドウを閉じる。
  unlistenClose = await appWindow.onCloseRequested(async (event) => {
    event.preventDefault()
    if (busy.value || mainCloseInProgress.value) return
    mainCloseInProgress.value = true
    void publishProjectTreeWindowState()
    documentLocked.value = true
    let destroyed = false
    try {
      if (dirty.value && !(await confirmDiscard())) return
      await flushAllSettingsChanges()
      await flushProjectTreePreferences()
      cancelRecoveryTimer()
      if (recoveryReady) {
        try {
          // 実行中の自動保存の後に削除を並べ、明示破棄した本文を復活させない。
          await saveRecoverySnapshot(null)
        } catch (error) {
          await showError('復元候補の削除', error)
        }
      }
      await closeSearchWindow()
      await closeProjectTreeWindowForExit()
      await appWindow.destroy()
      destroyed = true
    } catch (error) {
      await showError('終了処理', error)
    } finally {
      mainCloseInProgress.value = false
      if (!destroyed) {
        documentLocked.value = false
        projectTreeWindowClosingForExit = false
        void publishProjectTreeWindowState()
        scheduleRecoverySave()
        if (projectTreeDetached.value && !projectTreeWindow) await openProjectTreeWindow()
      }
    }
  })
  unlistenResize = await appWindow.onResized(() => { void updateMaximized() })
  unlistenSettingsCommand = await listen<SettingsCommand>(SETTINGS_COMMAND_EVENT, (event) => {
    void handleSettingsCommand(event.payload)
  })
  unlistenSearchCommand = await listen<SearchCommand>(SEARCH_COMMAND_EVENT, (event) => {
    handleSearchCommand(event.payload)
  })
  unlistenProjectTreeCommand = await listen<ProjectTreeWindowCommand>(PROJECT_TREE_WINDOW_COMMAND_EVENT, (event) => {
    handleProjectTreeWindowCommand(event.payload)
  })
  await updateMaximized()
  alwaysOnTop.value = await appWindow.isAlwaysOnTop()
  const recoveryLoaded = await initializeRecovery()
  if (props.storageInitializationReady && recoveryLoaded) {
    try {
      await confirmStorageStartup()
    } catch (error) {
      showPersistenceNotice(`移行元データを片付けられませんでした。次回起動時に再試行します。${String(error)}`)
    }
  }
  if (projectTreeDetached.value) await openProjectTreeWindow()
})

// 画面の破棄時に購読を解除し、同じ操作が重複して処理されることを防ぐ。
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  cancelRecoveryTimer()
  recoveryReady = false
  unlistenClose?.()
  unlistenResize?.()
  unlistenSettingsCommand?.()
  unlistenSearchCommand?.()
  unlistenProjectTreeCommand?.()
  unlistenViewportResize?.()
  searchWindowReady = false
  void searchWindow?.destroy()
  void settingsWindow?.destroy()
  if (projectTreeWindow) projectTreeWindowClosingForExit = true
  void projectTreeWindow?.destroy()
})
</script>

<template>
  <VApp class="app-shell">
    <VAppBar
      class="titlebar"
      :height="48"
      :extended="displayedToolbarVisible"
      :extension-height="40"
      flat
    >
      <nav class="menu-bar" aria-label="メニューバー">
        <VMenu v-model="fileMenuOpen" :close-on-content-click="false" :transition="false">
          <template #activator="{ props: fileMenuProps }">
            <VBtn v-bind="fileMenuProps" class="menu-heading" size="small" variant="text">ファイル</VBtn>
          </template>
          <VList density="compact" min-width="220" role="menu" aria-label="ファイル">
            <VListItem role="menuitem" :disabled="isCommandDisabled('document.new')" title="新規" @click="runMenuCommand('document.new')">
              <template #append><span class="menu-shortcut">{{ getCommandShortcut('document.new') }}</span></template>
            </VListItem>
            <VListItem role="menuitem" :disabled="isCommandDisabled('document.open')" title="開く" @click="runMenuCommand('document.open')">
              <template #append><span class="menu-shortcut">{{ getCommandShortcut('document.open') }}</span></template>
            </VListItem>
            <VListItem role="menuitem" :disabled="isCommandDisabled('document.save')" title="保存" @click="runMenuCommand('document.save')">
              <template #append><span class="menu-shortcut">{{ getCommandShortcut('document.save') }}</span></template>
            </VListItem>
            <VListItem role="menuitem" :disabled="isCommandDisabled('document.saveAs')" title="名前を付けて保存" @click="runMenuCommand('document.saveAs')">
              <template #append><span class="menu-shortcut">{{ getCommandShortcut('document.saveAs') }}</span></template>
            </VListItem>
          </VList>
        </VMenu>
        <VMenu v-model="editMenuOpen" :close-on-content-click="false" :transition="false">
          <template #activator="{ props: editMenuProps }">
            <VBtn v-bind="editMenuProps" class="menu-heading" size="small" variant="text">編集</VBtn>
          </template>
          <VList density="compact" min-width="220" role="menu" aria-label="編集">
            <VListItem role="menuitem" :disabled="isCommandDisabled('edit.find')" title="検索" @click="runMenuCommand('edit.find')">
              <template #append><span class="menu-shortcut">{{ getCommandShortcut('edit.find') }}</span></template>
            </VListItem>
            <VListItem role="menuitem" :disabled="isCommandDisabled('edit.replace')" title="置換" @click="runMenuCommand('edit.replace')">
              <template #append><span class="menu-shortcut">{{ getCommandShortcut('edit.replace') }}</span></template>
            </VListItem>
          </VList>
        </VMenu>
        <VMenu v-model="settingsMenuOpen" :close-on-content-click="false" :transition="false">
          <template #activator="{ props: settingsMenuProps }">
            <VBtn v-bind="settingsMenuProps" class="menu-heading" size="small" variant="text">設定</VBtn>
          </template>
          <VList density="compact" min-width="240" role="menu" aria-label="設定">
            <VListItem role="menuitem" title="設定画面を開く" @click="runMenuCommand('settings.open')" />
            <VDivider class="my-1" />
            <VMenu v-model="settingsSubmenuOpen" location="end" open-on-hover :close-on-content-click="false" :open-delay="100" :close-delay="200">
              <template #activator="{ props: submenuProps }">
                <VListItem v-bind="submenuProps" role="menuitem" title="折り返し設定" append-icon="mdi-chevron-right" />
              </template>
              <VList density="compact" min-width="240" role="menu" aria-label="折り返し設定">
                <VListItem role="menuitemradio" :aria-checked="editorSettings.wrapMode === 'window'" :active="editorSettings.wrapMode === 'window'" title="右端で折り返し" @click="runMenuCommand('wrap.window')">
                  <template #prepend><VIcon icon="mdi-check" :style="{ visibility: editorSettings.wrapMode === 'window' ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
                </VListItem>
                <VListItem role="menuitemradio" :aria-checked="editorSettings.wrapMode === 'columns'" :active="editorSettings.wrapMode === 'columns'" title="指定桁数で折り返し" @click="runMenuCommand('wrap.columns')">
                  <template #prepend><VIcon icon="mdi-check" :style="{ visibility: editorSettings.wrapMode === 'columns' ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
                </VListItem>
                <VListItem role="menuitemradio" :aria-checked="editorSettings.wrapMode === 'none'" :active="editorSettings.wrapMode === 'none'" title="折り返さない" @click="runMenuCommand('wrap.none')">
                  <template #prepend><VIcon icon="mdi-check" :style="{ visibility: editorSettings.wrapMode === 'none' ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
                </VListItem>
              </VList>
            </VMenu>
          </VList>
        </VMenu>
        <VMenu v-model="displayMenuOpen" :close-on-content-click="false" :transition="false">
          <template #activator="{ props: displayMenuProps }">
            <VBtn v-bind="displayMenuProps" class="menu-heading" size="small" variant="text">表示</VBtn>
          </template>
          <VList density="compact" min-width="240" role="menu" aria-label="表示">
            <VListItem role="menuitemcheckbox" :aria-checked="displayedToolbarVisible" :active="displayedToolbarVisible" title="ツールバーを表示" @click="runMenuCommand('view.toolbar.toggle')">
              <template #prepend><VIcon icon="mdi-check" :style="{ visibility: displayedToolbarVisible ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
            </VListItem>
            <VListItem role="menuitem" title="ツールバーをカスタマイズ…" @click="runMenuCommand('view.toolbar.customize')" />
          </VList>
        </VMenu>
        <VMenu v-model="windowMenuOpen" :close-on-content-click="false" :transition="false">
          <template #activator="{ props: windowMenuProps }">
            <VBtn v-bind="windowMenuProps" class="menu-heading" size="small" variant="text">ウィンドウ</VBtn>
          </template>
          <VList density="compact" min-width="260" role="menu" aria-label="ウィンドウ">
            <VListItem role="menuitem" title="最小化" @click="runMenuCommand('window.minimize')" />
            <VListItem role="menuitem" title="最大化" @click="runMenuCommand('window.maximize')" />
            <VListItem role="menuitem" title="縦方向に最大化" @click="runMenuCommand('window.maximizeVertical')" />
            <VListItem role="menuitem" title="横方向に最大化" @click="runMenuCommand('window.maximizeHorizontal')" />
            <VListItem role="menuitemcheckbox" :aria-checked="alwaysOnTop" :active="alwaysOnTop" title="常に手前に表示" @click="runMenuCommand('window.alwaysOnTop')">
              <template #prepend><VIcon icon="mdi-check" :style="{ visibility: alwaysOnTop ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
            </VListItem>
            <VDivider class="my-1" />
            <VListItem role="menuitem" title="閉じる" @click="runMenuCommand('window.close')" />
          </VList>
        </VMenu>
        <VBtn class="menu-heading menu-placeholder" size="small" variant="text" disabled>ヘルプ</VBtn>
      </nav>
      <div class="titlebar-drag-region" data-tauri-drag-region :title="path ?? '新規文書'">
        <div class="document-title">
          <span class="file-name">{{ displayName }}</span>
          <span v-if="dirty" class="dirty-indicator" aria-label="未保存">未保存</span>
        </div>
      </div>
      <div class="window-controls" aria-label="ウィンドウ操作">
        <VBtn icon variant="text" size="small" aria-label="最小化" title="最小化" @click="executeCommand('window.minimize')"><VIcon icon="mdi-minus" aria-hidden="true" /></VBtn>
        <VBtn icon variant="text" size="small" :aria-label="maximized ? '元に戻す' : '最大化'" :title="maximized ? '元に戻す' : '最大化'" @click="toggleMaximizeWindow"><VIcon :icon="maximized ? 'mdi-window-restore' : 'mdi-square-outline'" aria-hidden="true" /></VBtn>
        <VBtn class="window-close" icon variant="text" size="small" aria-label="閉じる" title="閉じる" @click="executeCommand('window.close')"><VIcon icon="mdi-close" aria-hidden="true" /></VBtn>
      </div>
      <template #extension>
        <div v-if="displayedToolbarVisible" class="toolbar-strip" role="toolbar" aria-label="ツールバー" @contextmenu="openToolbarContextMenu">
          <div class="toolbar-scroll">
            <template v-for="item in displayedToolbarItems" :key="item.type === 'command' ? item.commandId : item.id">
              <VDivider v-if="item.type === 'separator'" class="toolbar-divider" vertical inset />
              <VTooltip v-else :text="getCommandLabel(item.commandId)" location="bottom">
                <template #activator="{ props: tooltipProps }">
                  <VBtn
                    v-bind="tooltipProps"
                    class="toolbar-command"
                    icon
                    size="small"
                    :variant="isCommandChecked(item.commandId) ? 'tonal' : 'text'"
                    :color="isCommandChecked(item.commandId) ? 'primary' : undefined"
                    :disabled="isCommandDisabled(item.commandId)"
                    :aria-label="getCommandLabel(item.commandId)"
                    :aria-pressed="['wrap.window', 'wrap.columns', 'wrap.none', 'window.alwaysOnTop'].includes(item.commandId) ? isCommandChecked(item.commandId) : undefined"
                    @click="executeCommand(item.commandId)"
                  >
                    <VIcon :icon="appCommands[item.commandId].icon" aria-hidden="true" />
                  </VBtn>
                </template>
              </VTooltip>
            </template>
          </div>
        </div>
      </template>
    </VAppBar>
    <VMenu v-model="toolbarContextMenuOpen" :target="toolbarContextMenuTarget" location="bottom start" :close-on-content-click="true">
      <VList density="compact" min-width="240" role="menu" aria-label="ツールバー操作">
        <VListItem role="menuitem" title="ツールバーをカスタマイズ…" @click="executeCommand('view.toolbar.customize')" />
        <VDivider class="my-1" />
        <VListItem role="menuitem" title="ツールバーを非表示" @click="executeCommand('view.toolbar.toggle')" />
      </VList>
    </VMenu>
    <VSnackbar v-model="persistenceNoticeOpen" timeout="9000" location="bottom">
      {{ persistenceNotice }}
    </VSnackbar>
    <VNavigationDrawer
      v-if="!projectTreeDetached"
      class="project-navigation"
      app
      permanent
      :width="projectTreeDisplayWidth"
      aria-label="プロジェクトツリー"
    >
      <ProjectTreeSidebar
        :disabled="projectTreeWindowDisabled"
        :document-origin="documentOrigin"
        :expanded-folder-ids="expandedProjectTreeFolderIds"
        :unavailable-node-ids="projectTreeUnavailableNodeIds"
        :open-result="projectTreeOpenResult"
        @detach-request="requestProjectTreeDetach"
        @open-file="openProjectTreeFile"
        @open-result-applied="consumeProjectTreeOpenResult"
        @origin-detached="detachDocumentOrigin"
        @expanded-change="updateExpandedProjectTreeFolders"
        @unavailable-change="updateProjectTreeUnavailableNodeIds"
      />
      <div
        class="project-tree-resize-handle"
        role="separator"
        tabindex="0"
        aria-label="プロジェクトツリーの幅"
        aria-orientation="vertical"
        :aria-valuemin="220"
        :aria-valuemax="projectTreeMaximumWidth"
        :aria-valuenow="projectTreeDisplayWidth"
        @pointerdown="startProjectTreeResize"
        @pointermove="moveProjectTreeResize"
        @pointerup="endProjectTreeResize"
        @pointercancel="endProjectTreeResize"
        @keydown="onProjectTreeResizeKeydown"
      />
    </VNavigationDrawer>
    <VMain class="writing-area" aria-label="本文編集領域">
      <EditorPane ref="editor" :settings="editorSettings" :read-only="documentLocked" @change="onChange" @statistics="statistics = $event" @search-status="onSearchStatus" @search-navigate="onSearchNavigate" />
    </VMain>
    <VFooter app class="status-bar" height="36"><StatisticsStatus :statistics="statistics" /></VFooter>
  </VApp>
</template>
