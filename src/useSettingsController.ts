/** 設定値の適用と表示メトリクスをまとめ、保存・履歴・設定子窓へ橋渡しする。 */
import { computed, ref } from 'vue'
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
  normalizeInterfaceBarSizes,
  normalizeToolbarItems,
  type ApplicationPreferencesV1,
  type InterfaceBarSizes,
  type ToolbarPreferences,
} from './appPreferenceSchema'
import { cloneSettingsValues, type SettingsValues } from './settingsValues'
import { createSettingsHistory } from './settingsHistory'
import { createInterfaceBarStyle, getInterfaceBarMetrics } from './interfaceBarPresentation'
import { useSettingsPersistence } from './useSettingsPersistence'
import { useSettingsWindowBridge } from './useSettingsWindowBridge'
import {
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
  const settingsPage = ref<SettingsViewId>('editor.wrapping')
  const displayedToolbarItems = computed(() => toolbarPreferences.value.items)
  const displayedToolbarVisible = computed(() => toolbarPreferences.value.visible)
  const interfaceBarMetrics = computed(() => getInterfaceBarMetrics(barSizes.value))
  const interfaceBarStyle = computed(() => createInterfaceBarStyle(barSizes.value))
  const toolbarFontItems = computed(() => {
    const items: { title: string; value: string }[] = editorFontOptions.map((option) => ({ title: option.label, value: option.fontFamily }))
    if (!items.some((item) => item.value === editorSettings.value.fontFamily)) {
      items.push({ title: editorSettings.value.fontFamily, value: editorSettings.value.fontFamily })
    }
    return items
  })

  let disposed = false

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

  const settingsHistory = createSettingsHistory()

  /** 設定子窓へ配信する値を、保存対象と同じく参照独立な形で作る。 */
  function createSettingsSnapshot(): Omit<SettingsSnapshot, 'revision'> {
    return {
      editor: { ...editorSettings.value },
      toolbar: cloneToolbarPreferences(toolbarPreferences.value),
      barSizes: { ...barSizes.value },
      page: settingsPage.value,
      history: {
        canUndo: settingsHistory.canUndo,
        canRedo: settingsHistory.canRedo,
      },
    }
  }

  const settingsWindowBridge = useSettingsWindowBridge({
    getSnapshot: createSettingsSnapshot,
    onCommand: handleSettingsCommand,
    showError: options.showError,
    onDestroyed: handleSettingsWindowDestroyed,
  })
  const settingsWindowOpen = settingsWindowBridge.settingsWindowOpen

  /** 設定子窓が存在するときだけ状態を配信する。 */
  function publishSettingsState(): Promise<void> {
    return settingsWindowBridge?.publishState() ?? Promise.resolve()
  }

  /** Store書き込み失敗時に設定を戻し、既存の通知文言を維持する。 */
  function applySettingsRollback(snapshot: SettingsValues): void {
    editorSettings.value = { ...snapshot.editor }
    toolbarPreferences.value = cloneToolbarPreferences(snapshot.toolbar)
    barSizes.value = { ...snapshot.barSizes }
    settingsHistory.clear()
  }

  /** 保存失敗時にメイン画面と設定画面へ同じ内容を通知する。 */
  function notifySettingsRollback(error: unknown): void {
    const detail = `設定を保存できなかったため、直近の保存内容へ戻しました。${String(error)}`
    options.showPersistenceNotice(detail)
    if (settingsWindowBridge?.settingsWindowOpen.value) void settingsWindowBridge.publishError(detail)
  }

  /** 保存処理の予期しない例外を既存の通知へ変換する。 */
  function notifyUnexpectedSettingsSaveError(error: unknown): void {
    options.showPersistenceNotice(`設定の保存処理に失敗しました。${String(error)}`)
  }

  const settingsPersistence = useSettingsPersistence<SettingsValues>({
    clone: cloneSettingsValues,
    getSnapshot: cloneCurrentSettings,
    save: (snapshot) => saveSettingsPreferences(snapshot.editor, snapshot.toolbar, snapshot.barSizes),
    applyRollback: applySettingsRollback,
    notifyRollback: notifySettingsRollback,
    notifyUnexpectedError: notifyUnexpectedSettingsSaveError,
    publishState: publishSettingsState,
  })

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
      if (flushImmediately) settingsPersistence.requestFlush(true)
      return
    }

    if (recordHistory) settingsHistory.push(cloneCurrentSettings())
    editorSettings.value = nextEditor
    toolbarPreferences.value = nextToolbar
    barSizes.value = nextBarSizes
    settingsPersistence.markChanged()
    if (flushImmediately) settingsPersistence.requestFlush(true)
  }

  /** 設定ウィンドウの表示中だけ使うUndo履歴を新しく開始する。 */
  function beginSettingsHistorySession(): void {
    settingsHistory.beginSession()
  }

  /** 設定ウィンドウ終了時に履歴セッションを破棄する。 */
  function endSettingsHistorySession(): void {
    settingsHistory.endSession()
  }

  /** Undoで直前状態を適用し、現在状態をRedo履歴へ移す。 */
  function undoSettingsChange(): void {
    const previous = settingsHistory.undo(cloneCurrentSettings())
    if (!previous) return
    updateCurrentSettings(previous.editor, previous.toolbar, false, false, previous.barSizes)
    void publishSettingsState()
  }

  /** Redoで取り消した状態を適用し、現在状態をUndo履歴へ移す。 */
  function redoSettingsChange(): void {
    const next = settingsHistory.redo(cloneCurrentSettings())
    if (!next) return
    updateCurrentSettings(next.editor, next.toolbar, false, false, next.barSizes)
    void publishSettingsState()
  }

  /** 設定ウィンドウが閉じても確定済み設定を維持し、進行中の保存を続ける。 */
  function handleSettingsWindowDestroyed(): void {
    endSettingsHistorySession()
  }

  /** 設定画面から受けたページ遷移と型付き更新を処理する。 */
  async function handleSettingsCommand(command: SettingsCommand): Promise<void> {
    if (disposed) return
    try {
      if (command.type === 'ready') {
        if (!settingsHistory.active) beginSettingsHistorySession()
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
      if (!disposed) await settingsWindowBridge?.publishError(String(error))
    }
  }

  /** 設定ウィンドウを開き、指定されたページを表示して前面へ移す。 */
  async function openSettingsWindow(page: SettingsPageId = 'editor.wrapping'): Promise<void> {
    if (disposed) return
    settingsPage.value = page
    await settingsWindowBridge?.open()
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
    await settingsWindowBridge?.setup()
  }

  /** 終了前に遅延中の設定保存をすべて完了させる。 */
  async function flush(): Promise<void> {
    await settingsPersistence.flush()
  }

  /** 設定イベント、タイマー、設定ウィンドウを解除する。 */
  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    endSettingsHistorySession()
    settingsPersistence.dispose()
    await settingsWindowBridge?.dispose()
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
