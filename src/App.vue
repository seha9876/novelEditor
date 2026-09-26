<script setup lang="ts">
// 各Controllerを組み合わせ、横断処理とメイン画面のレイアウト配置を担う。
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { message } from '@tauri-apps/plugin-dialog'
import EditorPane from './EditorPane.vue'
import ProjectTreeSidebar from './ProjectTreeSidebar.vue'
import MainAppBar from './MainAppBar.vue'
import StatisticsStatus from './StatisticsStatus.vue'
import { appCommandDefinitions, findShortcutCommand, type AppCommand, type CommandId } from './appCommands'
import { confirmStorageStartup } from './storageLocation'
import type { PreferencesPersistenceState } from './appPreferences'
import type { ApplicationPreferencesV1 } from './appPreferenceSchema'
import { useDocumentSession, type DocumentEditorHandle } from './useDocumentSession'
import { useMainWindowController } from './useMainWindowController'
import { useProjectTreeWindowController } from './useProjectTreeWindowController'
import { useSearchController } from './useSearchController'
import { useSettingsController } from './useSettingsController'

const props = defineProps<{
  initialPreferences: ApplicationPreferencesV1
  persistenceState: PreferencesPersistenceState
  persistenceError?: string
  storageInitializationReady: boolean
}>()

const editor = ref<DocumentEditorHandle | null>(null)
const persistenceNotice = ref('')
const persistenceNoticeOpen = ref(false)
const mainCloseInProgress = ref(false)
let appLifecycleGeneration = 0
let appMounted = false

/** メイン画面の非同期初期化が現在のマウントに属しているか確認する。 */
function isAppLifecycleActive(generation: number): boolean {
  return appMounted && generation === appLifecycleGeneration
}

/** 永続化に関する状態を一時通知として表示する。 */
function showPersistenceNotice(text: string): void {
  persistenceNotice.value = text
  persistenceNoticeOpen.value = true
}

/** 操作名と発生した例外を利用者へ示す。Tauri のエラーダイアログを開く。 */
async function showError(action: string, error: unknown): Promise<void> {
  await message(`${action}に失敗しました。\n${String(error)}`, {
    title: '小説エディタ',
    kind: 'error',
  })
}

type ProjectTreeController = ReturnType<typeof useProjectTreeWindowController>
let projectTreeController!: ProjectTreeController
const documentSession = useDocumentSession({
  editor,
  mainCloseInProgress,
  showPersistenceNotice,
  showError,
  reportProjectTreeOpenResult: (result, sourceWindowId) => {
    projectTreeController.reportProjectTreeOpenResult(result, sourceWindowId)
  },
})
const projectTreeControllerInstance = useProjectTreeWindowController({
  initialPreferences: props.initialPreferences,
  busy: documentSession.busy,
  documentLocked: documentSession.documentLocked,
  documentOrigin: documentSession.documentOrigin,
  mainCloseInProgress,
  showPersistenceNotice,
  showError,
  openProjectTreeFile: documentSession.openProjectTreeFile,
  onOriginDetached: documentSession.detachDocumentOrigin,
})
projectTreeController = projectTreeControllerInstance
const mainWindowController = useMainWindowController({
  mainCloseInProgress,
  showError,
  onCloseRequested: handleCloseRequested,
})
const settingsController = useSettingsController({
  initialPreferences: props.initialPreferences,
  showPersistenceNotice,
  showError,
})
const searchController = useSearchController({
  editor,
  documentLocked: documentSession.documentLocked,
  mainCloseInProgress,
  appWindow: mainWindowController.appWindow,
  showPersistenceNotice,
  showError,
})

const {
  path,
  documentOrigin,
  dirty,
  statistics,
  busy,
  documentLocked,
  displayName,
  initializeRecovery,
  confirmDiscard,
  newDocument,
  openDocument,
  openProjectTreeFile,
  saveDocument,
  saveDocumentAs,
  onChange,
  flush: flushDocumentSession,
  clearRecoverySnapshot,
  resumeRecoverySave,
  dispose: disposeDocumentSession,
  detachDocumentOrigin,
} = documentSession
const {
  editorSettings,
  displayedToolbarItems,
  displayedToolbarVisible,
  interfaceBarMetrics,
  interfaceBarStyle,
  toolbarFontItems,
  updateToolbarFontFamily,
  updateToolbarTypographyNumber,
  adjustToolbarFontSize,
  openSettingsWindow,
  toggleToolbarVisibility,
  chooseWrapMode,
} = settingsController
const {
  projectTreeDetached,
  projectTreeResizing,
  expandedProjectTreeFolderIds,
  projectTreeUnavailableNodeIds,
  projectTreeOpenResult,
  projectTreeWindowDisabled,
  projectTreeMaximumWidth,
  projectTreeDisplayWidth,
  updateExpandedProjectTreeFolders,
  updateProjectTreeUnavailableNodeIds,
  consumeProjectTreeOpenResult,
  startProjectTreeResize,
  moveProjectTreeResize,
  endProjectTreeResize,
  onProjectTreeResizeKeydown,
  publishProjectTreeWindowState,
  openProjectTreeWindow,
  closeProjectTreeWindowForExit,
  restoreAfterCloseFailure,
  hasProjectTreeWindow,
  requestProjectTreeDetach,
  setup: setupProjectTreeWindowController,
  flush: flushProjectTreePreferences,
  dispose: disposeProjectTreeWindowController,
} = projectTreeController
const {
  open: openSearchWindow,
  close: closeSearchWindow,
  onStatus: onSearchStatus,
  onNavigate: onSearchNavigate,
  setup: setupSearchController,
  dispose: disposeSearchController,
} = searchController
const {
  appWindow,
  maximized,
  alwaysOnTop,
  minimizeWindow,
  toggleMaximizeWindow,
  maximizeWindow,
  maximizeWindowAxis,
  toggleAlwaysOnTop,
  closeWindow,
  setup: setupMainWindowController,
  dispose: disposeMainWindowController,
} = mainWindowController

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
  'toolbar.typography.fontFamily': async () => openSettingsWindow('editor.typography'),
  'toolbar.typography.fontSize': async () => openSettingsWindow('editor.typography'),
  'toolbar.typography.fontSizeAdjust': async () => openSettingsWindow('editor.typography'),
  'toolbar.typography.lineHeight': async () => openSettingsWindow('editor.typography'),
  'view.toolbar.toggle': toggleToolbarVisibility,
  'view.toolbar.customize': async () => openSettingsWindow('appearance.toolbar'),
}
const appCommands = Object.fromEntries(appCommandDefinitions.map((definition) => [definition.id, {
  ...definition,
  execute: commandActions[definition.id],
  isEnabled: () => !isCommandDisabled(definition.id),
  isChecked: () => isCommandChecked(definition.id),
}])) as Record<CommandId, AppCommand>

/** 文書処理中に利用できないコマンドを判定する。 */
function isCommandDisabled(commandId: CommandId): boolean {
  if (mainCloseInProgress.value) return true
  if (commandId === 'edit.find' || commandId === 'edit.replace') return documentLocked.value
  if (commandId.startsWith('toolbar.typography.')) return busy.value || documentLocked.value
  return busy.value && commandId.startsWith('document.')
}

/** 現在選択されている状態付きコマンドかを判定する。 */
function isCommandChecked(commandId: CommandId): boolean {
  if (commandId === 'wrap.window') return editorSettings.value.wrapMode === 'window'
  if (commandId === 'wrap.columns') return editorSettings.value.wrapMode === 'columns'
  if (commandId === 'wrap.none') return editorSettings.value.wrapMode === 'none'
  return commandId === 'window.alwaysOnTop' && alwaysOnTop.value
}

/** メニュー・ツールバーから共通コマンドを実行する。 */
function executeCommand(commandId: CommandId): void {
  const command = appCommands[commandId]
  if (!command.isEnabled()) return
  void command.execute()
}

/** コマンドIDから表示情報を取得する。 */
function getCommandLabel(commandId: CommandId): string {
  return appCommands[commandId].label
}

/** コマンド定義からショートカット表記を取得する。 */
function getCommandShortcut(commandId: CommandId): string | undefined {
  return appCommands[commandId].shortcut
}

/** 終了要求で待機中・実行中の保存をすべて完了させ、最後にメイン窓を破棄する。 */
async function handleCloseRequested(): Promise<void> {
  if (busy.value || mainCloseInProgress.value) return
  mainCloseInProgress.value = true
  void publishProjectTreeWindowState()
  documentLocked.value = true
  let destroyed = false
  try {
    if (dirty.value && !(await confirmDiscard())) return
    await settingsController.flush()
    await flushProjectTreePreferences()
    flushDocumentSession()
    try {
      await clearRecoverySnapshot()
    } catch (error) {
      await showError('復元候補の削除', error)
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
      restoreAfterCloseFailure()
      void publishProjectTreeWindowState()
      resumeRecoverySave()
      if (projectTreeDetached.value && !hasProjectTreeWindow()) await openProjectTreeWindow()
    }
  }
}

/** 修飾キーを含む共通ショートカットを処理する。 */
function onKeydown(event: KeyboardEvent): void {
  const command = findShortcutCommand(event)
  if (command) {
    event.preventDefault()
    executeCommand(command.id)
  }
}

// 画面のマウント時にショートカットと各コントローラーの購読を開始する。
onMounted(async () => {
  const generation = appLifecycleGeneration + 1
  appLifecycleGeneration = generation
  appMounted = true
  window.addEventListener('keydown', onKeydown, true)
  if (props.persistenceState !== 'ready') {
    const detail = props.persistenceError ? ` ${props.persistenceError}` : ''
    showPersistenceNotice(props.persistenceState === 'recovered'
      ? `設定データを読み込めなかったため、初期値で再作成しました。${detail}`
      : `設定を保存できません。今回の変更はアプリ終了後に失われます。${detail}`)
  }
  await setupMainWindowController()
  if (!isAppLifecycleActive(generation)) return
  await settingsController.setup()
  if (!isAppLifecycleActive(generation)) return
  await setupSearchController()
  if (!isAppLifecycleActive(generation)) return
  await setupProjectTreeWindowController()
  if (!isAppLifecycleActive(generation)) return
  const recoveryLoaded = await initializeRecovery()
  if (!isAppLifecycleActive(generation)) return
  if (props.storageInitializationReady && recoveryLoaded) {
    try {
      await confirmStorageStartup()
      if (!isAppLifecycleActive(generation)) return
    } catch (error) {
      if (!isAppLifecycleActive(generation)) return
      showPersistenceNotice(`移行元データを片付けられませんでした。次回起動時に再試行します。${String(error)}`)
    }
  }
  if (!isAppLifecycleActive(generation)) return
  if (projectTreeDetached.value) {
    await openProjectTreeWindow()
    if (!isAppLifecycleActive(generation)) return
  }
})

// 画面の破棄時に購読とタイマーを解除し、同じ操作が重複して処理されることを防ぐ。
onBeforeUnmount(() => {
  appMounted = false
  appLifecycleGeneration += 1
  window.removeEventListener('keydown', onKeydown, true)
  disposeDocumentSession()
  void disposeProjectTreeWindowController()
  disposeMainWindowController()
  void settingsController.dispose()
  void disposeSearchController()
})
</script>

<template>
  <VApp class="app-shell" :class="{ 'is-project-tree-resizing': projectTreeResizing }" :style="interfaceBarStyle">
    <MainAppBar
      :menu-height="interfaceBarMetrics.menu.height"
      :toolbar-height="interfaceBarMetrics.toolbar.height"
      :toolbar-visible="displayedToolbarVisible"
      :toolbar-items="displayedToolbarItems"
      :editor-settings="editorSettings"
      :toolbar-font-items="toolbarFontItems"
      :display-name="displayName"
      :document-path="path"
      :dirty="dirty"
      :maximized="maximized"
      :always-on-top="alwaysOnTop"
      :app-commands="appCommands"
      :is-command-disabled="isCommandDisabled"
      :is-command-checked="isCommandChecked"
      :get-command-label="getCommandLabel"
      :get-command-shortcut="getCommandShortcut"
      @command="executeCommand"
      @toggle-maximize="toggleMaximizeWindow"
      @update-font-family="updateToolbarFontFamily"
      @update-typography-number="updateToolbarTypographyNumber"
      @adjust-font-size="adjustToolbarFontSize"
    />
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
        @lostpointercapture="endProjectTreeResize"
        @keydown="onProjectTreeResizeKeydown"
      />
    </VNavigationDrawer>
    <VMain class="writing-area" aria-label="本文編集領域">
      <EditorPane ref="editor" :settings="editorSettings" :read-only="documentLocked" @change="onChange" @statistics="statistics = $event" @search-status="onSearchStatus" @search-navigate="onSearchNavigate" />
    </VMain>
    <VFooter app class="status-bar" :height="interfaceBarMetrics.status.height"><StatisticsStatus :statistics="statistics" /></VFooter>
  </VApp>
</template>
