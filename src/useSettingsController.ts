/** 設定値、設定画面のライフサイクル、保存と履歴をメイン画面から分離する。 */
import { computed, ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import {
  editorFontOptions,
  isValidTypographyNumber,
  normalizeEditorSettings,
  type EditorSettings,
  type WrapMode,
} from './editorSettings'
import {
  saveSettingsPreferences,
} from './appPreferences'
import {
  interfaceBarSizePresets,
  normalizeInterfaceBarSizes,
  normalizeToolbarItems,
  type ApplicationPreferencesV1,
  type InterfaceBarSizes,
  type ToolbarPreferences,
} from './appPreferenceSchema'
import { cloneSettingsValues, type SettingsValues } from './settingsValues'
import {
  SETTINGS_COMMAND_EVENT,
  SETTINGS_ERROR_EVENT,
  SETTINGS_STATE_EVENT,
  type SettingsCommand,
  type SettingsSnapshot,
} from './settingsSession'
import type { SettingsPageId, SettingsViewId } from './settingsDefinitions'

type SaveErrorNotifier = (text: string) => void
type OperationErrorNotifier = (action: string, error: unknown) => Promise<void>

export type SettingsControllerOptions = {
  initialPreferences: ApplicationPreferencesV1
  showPersistenceNotice: SaveErrorNotifier
  showError: OperationErrorNotifier
}

/** 設定値を正規化し、設定ウィンドウと永続Storeの間を接続する。 */
export function useSettingsController(options: SettingsControllerOptions) {
  const editorSettings = ref<EditorSettings>({ ...options.initialPreferences.editor })
  const toolbarPreferences = ref<ToolbarPreferences>({
    visible: options.initialPreferences.ui.toolbar.visible,
    items: options.initialPreferences.ui.toolbar.items.map((item) => ({ ...item })),
  })
  const barSizes = ref<InterfaceBarSizes>({ ...options.initialPreferences.ui.barSizes })
  const settingsWindowOpen = ref(false)
  const settingsPage = ref<SettingsViewId>('editor.wrapping')
  const displayedToolbarItems = computed(() => toolbarPreferences.value.items)
  const displayedToolbarVisible = computed(() => toolbarPreferences.value.visible)
  const interfaceBarMetrics = computed(() => ({
    menu: interfaceBarSizePresets[barSizes.value.menu].menu,
    toolbar: interfaceBarSizePresets[barSizes.value.toolbar].toolbar,
    status: interfaceBarSizePresets[barSizes.value.status].status,
  }))
  const interfaceBarStyle = computed<Record<string, string>>(() => ({
    '--menu-bar-height': `${interfaceBarMetrics.value.menu.height}px`,
    '--menu-control-height': `${interfaceBarMetrics.value.menu.controlHeight}px`,
    '--menu-icon-size': `${interfaceBarMetrics.value.menu.iconSize}px`,
    '--menu-font-size': interfaceBarMetrics.value.menu.fontSize,
    '--menu-title-font-size': interfaceBarMetrics.value.menu.titleFontSize,
    '--menu-secondary-font-size': interfaceBarMetrics.value.menu.secondaryFontSize,
    '--window-control-width': `${interfaceBarMetrics.value.menu.windowControlWidth}px`,
    '--menu-button-padding': `${interfaceBarMetrics.value.menu.buttonPadding}px`,
    '--menu-bar-padding': `${interfaceBarMetrics.value.menu.padding}px`,
    '--menu-bar-gap': `${interfaceBarMetrics.value.menu.gap}px`,
    '--menu-title-gap': `${interfaceBarMetrics.value.menu.titleGap}px`,
    '--menu-title-padding': `${interfaceBarMetrics.value.menu.titlePadding}px`,
    '--toolbar-bar-height': `${interfaceBarMetrics.value.toolbar.height}px`,
    '--toolbar-control-height': `${interfaceBarMetrics.value.toolbar.controlHeight}px`,
    '--toolbar-button-height': `${interfaceBarMetrics.value.toolbar.buttonHeight}px`,
    '--toolbar-button-width': `${interfaceBarMetrics.value.toolbar.buttonWidth}px`,
    '--toolbar-adjust-button-width': `${interfaceBarMetrics.value.toolbar.adjustButtonWidth}px`,
    '--toolbar-icon-size': `${interfaceBarMetrics.value.toolbar.iconSize}px`,
    '--toolbar-font-size': interfaceBarMetrics.value.toolbar.fontSize,
    '--toolbar-input-font-size': interfaceBarMetrics.value.toolbar.inputFontSize,
    '--toolbar-label-font-size': interfaceBarMetrics.value.toolbar.labelFontSize,
    '--toolbar-font-width': `${interfaceBarMetrics.value.toolbar.fontWidth}px`,
    '--toolbar-number-width': `${interfaceBarMetrics.value.toolbar.numberWidth}px`,
    '--toolbar-number-menu-width': `${interfaceBarMetrics.value.toolbar.numberMenuWidth}px`,
    '--toolbar-bar-padding': `${interfaceBarMetrics.value.toolbar.padding}px`,
    '--toolbar-bar-gap': `${interfaceBarMetrics.value.toolbar.gap}px`,
    '--toolbar-item-margin': `${interfaceBarMetrics.value.toolbar.itemMargin}px`,
    '--toolbar-divider-height': `${interfaceBarMetrics.value.toolbar.dividerHeight}px`,
    '--toolbar-divider-margin': `${interfaceBarMetrics.value.toolbar.dividerMargin}px`,
    '--status-bar-height': `${interfaceBarMetrics.value.status.height}px`,
    '--status-font-size': interfaceBarMetrics.value.status.fontSize,
    '--status-gap': `${interfaceBarMetrics.value.status.gap}px`,
    '--status-bar-padding': `${interfaceBarMetrics.value.status.padding}px`,
    '--status-button-height': `${interfaceBarMetrics.value.status.buttonHeight}px`,
    '--status-button-padding': `${interfaceBarMetrics.value.status.buttonPadding}px`,
    '--status-button-font-size': interfaceBarMetrics.value.status.buttonFontSize,
    '--status-button-icon-size': `${interfaceBarMetrics.value.status.buttonIconSize}px`,
  }))
  const toolbarFontItems = computed(() => {
    const items: { title: string; value: string }[] = editorFontOptions.map((option) => ({ title: option.label, value: option.fontFamily }))
    if (!items.some((item) => item.value === editorSettings.value.fontFamily)) {
      items.push({ title: editorSettings.value.fontFamily, value: editorSettings.value.fontFamily })
    }
    return items
  })

  let unlistenSettingsCommand: (() => void) | undefined
  let setupPromise: Promise<void> | null = null
  let disposed = false
  let settingsWindowOpening = false
  let settingsWindow: WebviewWindow | null = null
  let settingsSaveTimer: ReturnType<typeof setTimeout> | undefined
  let settingsSavePromise: Promise<void> | null = null
  let flushAfterCurrentSave = false
  let trailingSaveDue = false
  let settingsChangeRevision = 0
  let persistedSettingsRevision = 0
  let settingsStateRevision = 0
  let lastPersistedSettings = cloneCurrentSettings()
  let settingsHistoryActive = false
  const settingsUndoHistory: SettingsValues[] = []
  const settingsRedoHistory: SettingsValues[] = []
  const settingsHistoryLimit = 100

  /** 設定ウィンドウへ保存エラーをbest-effortで通知する。 */
  async function publishSettingsError(detail: string): Promise<void> {
    if (disposed) return
    try {
      if (!await WebviewWindow.getByLabel('settings')) return
      await emitTo('settings', SETTINGS_ERROR_EVENT, detail)
    } catch {
      // メイン画面の通知を維持し、設定ウィンドウへの通知失敗は保存状態へ波及させない。
    }
  }

  /** ツールバー設定を別画面へ渡す際の参照共有を避ける。 */
  function cloneToolbarPreferences(value: ToolbarPreferences): ToolbarPreferences {
    return { visible: value.visible, items: value.items.map((item) => ({ ...item })) }
  }

  /** 現在の設定値を履歴・保存用スナップショットへ複製する。 */
  function cloneCurrentSettings(): SettingsValues {
    return cloneSettingsValues({
      editor: editorSettings.value,
      toolbar: toolbarPreferences.value,
      barSizes: barSizes.value,
    })
  }

  /** 状態配信をbest-effortで行い、閉じかけの設定ウィンドウで保存処理を止めない。 */
  async function publishSettingsState(): Promise<void> {
    if (disposed) return
    try {
      if (!await WebviewWindow.getByLabel('settings')) return
      const snapshot: SettingsSnapshot = {
        editor: { ...editorSettings.value },
        toolbar: cloneToolbarPreferences(toolbarPreferences.value),
        barSizes: { ...barSizes.value },
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
      if (!disposed) options.showPersistenceNotice(`設定の保存処理に失敗しました。${String(error)}`)
    })
  }

  /** Store書き込み失敗時に現在値を直近の保存成功値へ戻す。 */
  function restoreLastPersistedSettings(error: unknown): void {
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
    settingsSaveTimer = undefined
    editorSettings.value = { ...lastPersistedSettings.editor }
    toolbarPreferences.value = cloneToolbarPreferences(lastPersistedSettings.toolbar)
    barSizes.value = { ...lastPersistedSettings.barSizes }
    settingsChangeRevision += 1
    persistedSettingsRevision = settingsChangeRevision
    flushAfterCurrentSave = false
    trailingSaveDue = false
    clearSettingsHistory()

    const detail = `設定を保存できなかったため、直近の保存内容へ戻しました。${String(error)}`
    if (!disposed) options.showPersistenceNotice(detail)
    if (!disposed && settingsWindowOpen.value) void publishSettingsError(detail)
    void publishSettingsState()
  }

  /** Storeへの1回の書き込みを実行し、失敗はrollbackと通知へ変換して解決する。 */
  async function runSettingsSaveCycle(
    writeSnapshot: { editor: EditorSettings; toolbar: ToolbarPreferences; barSizes: InterfaceBarSizes },
    writeRevision: number,
  ): Promise<boolean> {
    try {
      await publishSettingsState()
      await saveSettingsPreferences(writeSnapshot.editor, writeSnapshot.toolbar, writeSnapshot.barSizes)
      lastPersistedSettings = cloneSettingsValues(writeSnapshot)
      persistedSettingsRevision = writeRevision
      await publishSettingsState()
      return true
    } catch (error) {
      restoreLastPersistedSettings(error)
      return false
    }
  }

  /** 保存要求を共有Promise内で完了し、即時要求があれば最新状態まで続けて保存する。 */
  async function runSettingsSaveSequence(immediate: boolean): Promise<void> {
    let flushImmediately = immediate
    while (settingsChangeRevision > persistedSettingsRevision) {
      const writeRevision = settingsChangeRevision
      const writeSnapshot = cloneCurrentSettings()
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

  /** 現在値を即時反映し、変更があれば末尾デバウンスまたは即時保存を予約する。 */
  function updateCurrentSettings(
    editorPatch?: Partial<EditorSettings>,
    toolbarPatch?: Partial<ToolbarPreferences>,
    flushImmediately = false,
    recordHistory = true,
    barSizesPatch?: Partial<InterfaceBarSizes>,
  ): void {
    const nextEditor = normalizeEditorSettings({ ...editorSettings.value, ...editorPatch })
    const nextToolbar = {
      ...toolbarPreferences.value,
      ...toolbarPatch,
      items: toolbarPatch?.items
        ? normalizeToolbarItems(toolbarPatch.items)
        : toolbarPreferences.value.items.map((item) => ({ ...item })),
    }
    const nextBarSizes = normalizeInterfaceBarSizes({ ...barSizes.value, ...barSizesPatch })
    const hasChanged = JSON.stringify(nextEditor) !== JSON.stringify(editorSettings.value) ||
      JSON.stringify(nextToolbar) !== JSON.stringify(toolbarPreferences.value) ||
      JSON.stringify(nextBarSizes) !== JSON.stringify(barSizes.value)
    if (!hasChanged) {
      if (flushImmediately) requestSettingsFlush(true)
      return
    }

    if (recordHistory && settingsHistoryActive) {
      settingsUndoHistory.push(cloneCurrentSettings())
      if (settingsUndoHistory.length > settingsHistoryLimit) settingsUndoHistory.shift()
      settingsRedoHistory.length = 0
    }
    editorSettings.value = nextEditor
    toolbarPreferences.value = nextToolbar
    barSizes.value = nextBarSizes
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
    settingsRedoHistory.push(cloneCurrentSettings())
    updateCurrentSettings(previous.editor, previous.toolbar, false, false, previous.barSizes)
    void publishSettingsState()
  }

  /** Redoで取り消した状態を適用し、現在状態をUndo履歴へ移す。 */
  function redoSettingsChange(): void {
    const next = settingsRedoHistory.pop()
    if (!next) return
    settingsUndoHistory.push(cloneCurrentSettings())
    updateCurrentSettings(next.editor, next.toolbar, false, false, next.barSizes)
    void publishSettingsState()
  }

  /** 設定ウィンドウが閉じても確定済み設定を維持し、進行中の保存を続ける。 */
  function handleSettingsWindowDestroyed(destroyedWindow: WebviewWindow): void {
    if (settingsWindow !== destroyedWindow) return
    settingsWindow = null
    settingsWindowOpening = false
    settingsWindowOpen.value = false
    endSettingsHistorySession()
  }

  /** 設定画面から受けたページ遷移と型付き更新を処理する。 */
  async function handleSettingsCommand(command: SettingsCommand): Promise<void> {
    if (disposed) return
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
        updateCurrentSettings(command.editor, command.toolbar, command.flush ?? false, true, command.barSizes)
      }
    } catch (error) {
      if (!disposed) await emitTo('settings', SETTINGS_ERROR_EVENT, String(error))
    }
  }

  /** 設定ウィンドウを開き、指定されたページを表示して前面へ移す。 */
  async function openSettingsWindow(page: SettingsPageId = 'editor.wrapping'): Promise<void> {
    if (disposed) return
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
        if (!disposed) void options.showError('設定画面を開く操作', event.payload)
      })
    } catch (error) {
      settingsWindowOpening = false
      settingsWindowOpen.value = false
      if (!disposed) await options.showError('設定画面を開く操作', error)
    }
  }

  /** メニューから選んだ折り返し方法を即時反映し、自動保存へ渡す。 */
  async function chooseWrapMode(mode: WrapMode): Promise<void> {
    updateCurrentSettings({ wrapMode: mode })
    if (settingsWindowOpen.value) settingsPage.value = 'editor.wrapping'
    void publishSettingsState()
  }

  /** ツールバー設定を別画面へ送る共通更新経路へ渡す。 */
  function updateToolbarFontFamily(value: unknown): void {
    if (typeof value !== 'string') return
    const option = editorFontOptions.find((candidate) => candidate.fontFamily === value)
    updateCurrentSettings(option
      ? { fontFamily: option.fontFamily, fontFallback: option.fontFallback }
      : { fontFamily: value })
  }

  /** ツールバーの数値入力を本文設定の共通範囲で検証して保存する。 */
  function updateToolbarTypographyNumber(field: 'fontSize' | 'lineHeight', value: number): void {
    if (!isValidTypographyNumber(field, value)) return
    updateCurrentSettings({ [field]: value })
  }

  /** 本文文字サイズを1pxずつ調整し、12～48pxの範囲を超えないようにする。 */
  function adjustToolbarFontSize(direction: -1 | 1): void {
    const next = editorSettings.value.fontSize + direction
    if (isValidTypographyNumber('fontSize', next)) updateCurrentSettings({ fontSize: next })
  }

  /** 設定変更を設定ウィンドウとメイン画面の共通自動保存経路へ送る。 */
  async function toggleToolbarVisibility(): Promise<void> {
    updateCurrentSettings(undefined, { visible: !toolbarPreferences.value.visible })
  }

  /** 設定イベント購読を開始する。終了処理は同じコントローラーのdisposeへ集約する。 */
  async function setup(): Promise<void> {
    if (disposed) return
    if (setupPromise) return setupPromise
    if (unlistenSettingsCommand) return
    const setupRun = (async () => {
      const lateUnlisten = await listen<SettingsCommand>(SETTINGS_COMMAND_EVENT, (event) => {
        void handleSettingsCommand(event.payload)
      })
      if (disposed) {
        lateUnlisten()
        return
      }
      unlistenSettingsCommand = lateUnlisten
    })()
    setupPromise = setupRun
    try {
      await setupRun
    } finally {
      if (setupPromise === setupRun) setupPromise = null
    }
  }

  /** 終了前に遅延中の設定保存をすべて完了させる。 */
  async function flush(): Promise<void> {
    while (settingsSaveTimer || settingsSavePromise || settingsChangeRevision > persistedSettingsRevision) {
      await flushSettingsSave(true)
    }
  }

  /** 設定イベント、タイマー、設定ウィンドウを解除する。 */
  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
    settingsSaveTimer = undefined
    unlistenSettingsCommand?.()
    unlistenSettingsCommand = undefined
    endSettingsHistorySession()
    settingsWindowOpen.value = false
    void settingsWindow?.destroy()
    settingsWindow = null
  }

  return {
    editorSettings,
    displayedToolbarItems,
    displayedToolbarVisible,
    interfaceBarMetrics,
    interfaceBarStyle,
    toolbarFontItems,
    toggleToolbarVisibility,
    chooseWrapMode,
    updateToolbarFontFamily,
    updateToolbarTypographyNumber,
    adjustToolbarFontSize,
    openSettingsWindow,
    setup,
    flush,
    dispose,
  }
}
