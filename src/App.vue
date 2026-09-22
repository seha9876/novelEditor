<script setup lang="ts">
// 文書操作と画面表示をまとめ、本文そのものは EditorPane の CodeMirror に保持する。
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import EditorPane from './EditorPane.vue'
import {
  normalizeEditorSettings,
  type EditorSettings,
  type WrapMode,
} from './editorSettings'
import { appCommandDefinitions, type AppCommand, type CommandId } from './appCommands'
import {
  saveSettingsPreferences,
  normalizeToolbarItems,
  type ApplicationPreferencesV1,
  type PreferencesPersistenceState,
  type ToolbarPreferences,
} from './appPreferences'
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
  /** 本文と改行形式を切り替え、編集履歴を初期化する。 */
  setDocument: (text: string, lineEnding?: LineEnding) => void
  /** 本文領域へ入力フォーカスを移す。 */
  focus: () => void
}

const props = defineProps<{
  initialPreferences: ApplicationPreferencesV1
  persistenceState: PreferencesPersistenceState
  persistenceError?: string
}>()

type SettingsValues = {
  editor: EditorSettings
  toolbar: ToolbarPreferences
}

// 本文は CodeMirror、設定はVueの現在値を正本とし、設定更新は明示保存経路へ集約する。
const editor = ref<EditorHandle | null>(null)
const path = ref<string | null>(null)
const savedText = ref('')
const dirty = ref(false)
const charCount = ref(0)
const busy = ref(false)
const currentFile = ref<TextFile | null>(null)
const maximized = ref(false)
const alwaysOnTop = ref(false)
const openMenu = ref<'file' | 'settings' | 'display' | 'window' | null>(null)
const settingsSubmenuOpen = ref(false)
const appWindow = getCurrentWindow()
const editorSettings = ref<EditorSettings>({ ...props.initialPreferences.editor })
const toolbarPreferences = ref<ToolbarPreferences>({
  visible: props.initialPreferences.ui.toolbar.visible,
  items: props.initialPreferences.ui.toolbar.items.map((item) => ({ ...item })),
})
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
const displayName = computed(() => path.value ? fileName(path.value) : '無題')
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
let mainCloseInProgress = false

const commandActions: Record<CommandId, () => Promise<void>> = {
  'document.new': newDocument,
  'document.open': openDocument,
  'document.save': saveDocument,
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

/** CodeMirror から受けた本文と文字数で表示を更新し、保存済み本文との差から未保存状態を判定する。 */
function onChange(text: string, count: number): void {
  charCount.value = count
  dirty.value = text !== savedText.value
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
  if (busy.value || !(await confirmDiscard())) return
  path.value = null
  currentFile.value = null
  savedText.value = ''
  editor.value?.setDocument('')
  editor.value?.focus()
}

/** 選択した TXT を読み込み、本文・保存先・未保存判定の基準を更新する。選択取消時は現状を保つ。 */
async function openDocument(): Promise<void> {
  if (busy.value || !(await confirmDiscard())) return
  busy.value = true
  try {
    const selected = await chooseTextFile()
    if (!selected) return
    const file = await loadTextFile(selected)
    currentFile.value = file
    path.value = file.path
    editor.value?.setDocument(file.text, file.lineEnding)
    // CodeMirror は改行を内部表現へ揃えるため、未保存判定の基準も読み込み後の本文に合わせる。
    file.editorText = editor.value?.getText() ?? file.text
    savedText.value = file.editorText
    dirty.value = false
    editor.value?.focus()
  } catch (error) {
    await showError('ファイルを開く操作', error)
  } finally {
    busy.value = false
  }
}

/** 現在の本文を TXT に書き込み、成功した内容を保存済みの基準にする。保存先がなければ選択を求める。 */
async function saveDocument(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const target = path.value ?? await chooseSavePath('無題.txt')
    if (!target) return
    const text = editor.value?.getText() ?? ''
    const lineEnding = currentFile.value?.lineEnding ?? '\n'
    const hasBom = currentFile.value?.hasBom ?? false
    await saveTextFile(target, text, lineEnding, hasBom, currentFile.value ?? undefined)
    path.value = target
    savedText.value = text
    // 書き込み中にも編集できるので、保存開始時の本文と現在の本文を改めて比較する。
    dirty.value = (editor.value?.getText() ?? '') !== text
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
  return busy.value && (commandId === 'document.new' || commandId === 'document.open' || commandId === 'document.save')
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

/** Esc でメニューを閉じ、ファイル操作の Ctrl ショートカットを処理する。 */
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
  if (event.ctrlKey && !event.altKey && !event.shiftKey) {
    const shortcut = `ctrl+${event.key.toLowerCase()}`
    const command = appCommandDefinitions.find((definition) => definition.shortcut?.toLowerCase() === shortcut)
    if (command) {
      event.preventDefault()
      executeCommand(command.id)
    }
  }
}

// 画面のマウント時にショートカットと Tauri のウィンドウ終了要求を購読する。
onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  if (props.persistenceState !== 'ready') {
    const detail = props.persistenceError ? ` ${props.persistenceError}` : ''
    showPersistenceNotice(props.persistenceState === 'recovered'
      ? `設定データを読み込めなかったため、初期値で再作成しました。${detail}`
      : `設定を保存できません。今回の変更はアプリ終了後に失われます。${detail}`)
  }
  // 設定保存と文書終了確認を終えてから、メインウィンドウを閉じる。
  unlistenClose = await appWindow.onCloseRequested(async (event) => {
    if (busy.value) {
      event.preventDefault()
      return
    }
    const settingsNeedFlush = !!settingsSaveTimer || !!settingsSavePromise || settingsChangeRevision > persistedSettingsRevision
    if (!dirty.value && !settingsNeedFlush) return
    event.preventDefault()
    if (mainCloseInProgress) return
    mainCloseInProgress = true
    try {
      if (dirty.value && !(await confirmDiscard())) return
      await flushAllSettingsChanges()
      await appWindow.destroy()
    } catch (error) {
      await showError('設定の保存', error)
    } finally {
      mainCloseInProgress = false
    }
  })
  unlistenResize = await appWindow.onResized(() => { void updateMaximized() })
  unlistenSettingsCommand = await listen<SettingsCommand>(SETTINGS_COMMAND_EVENT, (event) => {
    void handleSettingsCommand(event.payload)
  })
  await updateMaximized()
  alwaysOnTop.value = await appWindow.isAlwaysOnTop()
})

// 画面の破棄時に購読を解除し、同じ操作が重複して処理されることを防ぐ。
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unlistenClose?.()
  unlistenResize?.()
  unlistenSettingsCommand?.()
  void settingsWindow?.destroy()
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
    <VMain class="writing-area" aria-label="本文編集領域">
      <EditorPane ref="editor" :settings="editorSettings" @change="onChange" />
    </VMain>
    <VFooter app class="status-bar" height="36">{{ charCount.toLocaleString('ja-JP') }} 文字</VFooter>
  </VApp>
</template>
