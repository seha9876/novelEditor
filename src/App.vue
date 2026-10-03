<script setup lang="ts">
// 各Controllerを組み合わせ、横断処理とメイン画面のレイアウト配置を担う。
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { message } from '@tauri-apps/plugin-dialog'
import EditorPane from './EditorPane.vue'
import ProjectTreeSidebar from './ProjectTreeSidebar.vue'
import SidebarShell from './SidebarShell.vue'
import SidebarSearchPanel from './SidebarSearchPanel.vue'
import SidebarHistoryPanel from './SidebarHistoryPanel.vue'
import OutlinePanel from './OutlinePanel.vue'
import { useSidebarSearch } from './useSidebarSearch'
import { useSidebarHistory } from './useSidebarHistory'
import type { SidebarPanelId } from './sidebarModel'
import MainAppBar from './MainAppBar.vue'
import ProjectNameDialog from './ProjectNameDialog.vue'
import QuickOpenDialog from './QuickOpenDialog.vue'
import RecentFilesDialog from './RecentFilesDialog.vue'
import GitHistoryDialog from './GitHistoryDialog.vue'
import { useGitHistoryController } from './useGitHistoryController'
import StatisticsStatus from './StatisticsStatus.vue'
import { appCommandDefinitions, findShortcutCommand, type AppCommand, type CommandId } from './appCommands'
import { confirmStorageStartup } from './storageLocation'
import type { PreferencesPersistenceState } from './appPreferences'
import type { ApplicationPreferencesV1 } from './appPreferenceSchema'
import { useDocumentSession, type DocumentEditorHandle } from './useDocumentSession'
import { useMainWindowController } from './useMainWindowController'
import { useProjectTreeWindowController } from './useProjectTreeWindowController'
import { useProjectTreeProjectController } from './useProjectTreeProjectController'
import { useSearchController } from './useSearchController'
import { useSettingsController } from './useSettingsController'
import { useQuickOpenController } from './useQuickOpenController'
import { useRecentFilesController } from './useRecentFilesController'
import { recordRecentFile } from './recentFiles'
import ExternalFileDialog from './ExternalFileDialog.vue'
import { useExternalFileMonitor } from './useExternalFileMonitor'
import { createAppearanceHost } from './appearanceChannel'
import { applyAppearance } from './appearancePresentation'

const props = defineProps<{
  initialPreferences: ApplicationPreferencesV1
  persistenceState: PreferencesPersistenceState
  persistenceError?: string
  storageInitializationReady: boolean
}>()

const editor = ref<(DocumentEditorHandle & { openLineNavigation: () => void }) | null>(null)
const persistenceNotice = ref('')
const persistenceNoticeOpen = ref(false)
const mainCloseInProgress = ref(false)
const focusMode = ref(false)
const gitHistoryOpen = ref(false)
const documentRevision = ref(0)
const documentHead = ref(0)
const historyRefreshRevision = ref(0)
const statusBarContextMenuOpen = ref(false)
const statusBarContextMenuTarget = ref<[number, number]>([0, 0])
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

/** 右クリック位置へステータスバーの操作メニューを開く。 */
function openStatusBarContextMenu(event: MouseEvent): void {
  event.preventDefault()
  statusBarContextMenuTarget.value = [event.clientX, event.clientY]
  statusBarContextMenuOpen.value = true
}

/** ステータスバーの設定ページを開く。 */
function openStatusBarSettings(): void {
  void openSettingsWindow('appearance.statusBar')
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
let sidebarSearchController: ReturnType<typeof useSidebarSearch> | null = null
let quickOpenController: ReturnType<typeof useQuickOpenController> | null = null
const documentSession = useDocumentSession({
  editor,
  mainCloseInProgress,
  showPersistenceNotice,
  showError,
  onFileAccessed: recordRecentFile,
  fileNavigationBlocked: gitHistoryOpen,
  reportProjectTreeOpenResult: (result, sourceWindowId) => {
    projectTreeController.reportProjectTreeOpenResult(result, sourceWindowId)
    if (sidebarSearchController?.receiveOpenResult(result)) projectTreeController.consumeProjectTreeOpenResult(result.requestId)
    if (quickOpenController?.receiveOpenResult(result)) projectTreeController.consumeProjectTreeOpenResult(result.requestId)
  },
})
const gitHistory = useGitHistoryController({
  isOpen: gitHistoryOpen,
  disabled: computed(() => documentSession.busy.value || mainCloseInProgress.value || !!documentSession.externalDialog.value),
  path: documentSession.path,
  dirty: documentSession.dirty,
  externalState: documentSession.externalState,
  externalError: documentSession.externalError,
  saveDocument: documentSession.saveDocument,
})
const editorInteractionLocked = computed(() => documentSession.documentLocked.value || gitHistoryOpen.value)
const projectTreeControllerInstance = useProjectTreeWindowController({
  initialPreferences: props.initialPreferences,
  busy: documentSession.busy,
  documentLocked: editorInteractionLocked,
  documentOrigin: documentSession.documentOrigin,
  mainCloseInProgress,
  showPersistenceNotice,
  showError,
  openProjectTreeFile: documentSession.openProjectTreeFile,
  onOriginDetached: documentSession.detachDocumentOrigin,
})
projectTreeController = projectTreeControllerInstance
const projectControllerDisabled = computed(() => mainCloseInProgress.value || documentSession.busy.value || gitHistoryOpen.value)
const projectController = useProjectTreeProjectController({
  disabled: projectControllerDisabled,
  documentOrigin: documentSession.documentOrigin,
  showError: (error) => showError('プロジェクト操作', error),
  onOriginDetached: documentSession.detachDocumentOrigin,
})
const quickOpenDisabled = computed(() => projectController.busy.value || documentSession.documentLocked.value)
const quickOpen = useQuickOpenController({
  snapshot: projectController.snapshot,
  disabled: quickOpenDisabled,
  openFile: documentSession.openProjectTreeFile,
})
quickOpenController = quickOpen
const recentFilesDisabled = computed(() => documentSession.busy.value || documentSession.documentLocked.value || mainCloseInProgress.value)
const recentFiles = useRecentFilesController({ disabled: recentFilesDisabled, openFile: documentSession.openRecentDocument })
const mainWindowController = useMainWindowController({
  mainCloseInProgress,
  showError,
  onCloseRequested: handleCloseRequested,
})
const externalFileMonitor = useExternalFileMonitor({
  appWindow: mainWindowController.appWindow,
  check: documentSession.checkExternalFile,
  onError: (error) => showPersistenceNotice(`外部更新の監視を開始できません。保存時の確認は有効です。${String(error)}`),
})
const appearanceHost = createAppearanceHost(props.initialPreferences.ui.appearance.colors, applyAppearance)
const settingsController = useSettingsController({
  initialPreferences: props.initialPreferences,
  showPersistenceNotice,
  showError,
  onAppearanceChanged: appearanceHost.update,
  onAppearanceFlush: appearanceHost.flush,
})
const searchController = useSearchController({
  editor,
  documentLocked: editorInteractionLocked,
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
  displayedStatusBarItems,
  interfaceBarMetrics,
  interfaceBarStyle,
  adjustToolbarFontSize,
  adjustToolbarLineHeight,
  openSettingsWindow,
  toggleToolbarVisibility,
  chooseWrapMode,
} = settingsController
const {
  activeSidebarPanel,
  selectSidebarPanel,
  dockProjectTreeWindow,
  projectTreeDetached,
  projectTreeCollapsed,
  projectTreeVisuallyCollapsed,
  projectTreeDrawerWidth,
  toggleProjectTreeCollapsed,
  projectTreeResizing,
  expandedProjectTreeFolderIds,
  projectTreeUnavailableNodeIds,
  projectTreeOpenResult,
  projectTreeWindowDisabled,
  projectTreeMaximumWidth,
  updateExpandedProjectTreeFolders,
  updateProjectTreeUnavailableNodeIds,
  consumeProjectTreeOpenResult,
  startProjectTreeResize,
  moveProjectTreeResize,
  endProjectTreeResize,
  cancelProjectTreeResize,
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
  projects: projectMenuProjects,
  activeProjectId: projectMenuActiveProjectId,
  busy: projectControllerBusy,
  projectDialogOpen,
  projectDialogTitle,
  projectDialogValue,
  projectDialogSave,
  requestProjectCreate,
  requestProjectRename,
  requestProjectDelete,
  changeProject: changeMenuProject,
  setup: setupProjectController,
  dispose: disposeProjectController,
} = projectController
const projectMenuDisabled = computed(() => projectControllerDisabled.value || projectControllerBusy.value)
const {
  open: openSearchWindow,
  close: closeSearchWindow,
  onStatus: onSearchStatus,
  onScope: onSearchScope,
  searchScope,
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

const visibleSidebarPanel = computed(() => !focusMode.value && !projectTreeVisuallyCollapsed.value ? activeSidebarPanel.value : null)
const visitedPanels = ref(new Set<SidebarPanelId>([activeSidebarPanel.value, 'project']))
const sidebarDisabled = computed(() => editorInteractionLocked.value || mainCloseInProgress.value || busy.value)
const sidebarSearch = useSidebarSearch({
  active: computed(() => visibleSidebarPanel.value === 'search'), editor, revision: documentRevision, path,
  conditions: searchController.conditions, snapshot: projectController.snapshot, disabled: sidebarDisabled, openFile: openProjectTreeFile,
})
sidebarSearchController = sidebarSearch
const sidebarHistory = useSidebarHistory({
  active: computed(() => visibleSidebarPanel.value === 'history'), path, disabled: sidebarDisabled, refreshRevision: historyRefreshRevision,
})
watch(documentSession.saveRevision, () => { historyRefreshRevision.value++ })
watch(visibleSidebarPanel, panel => {
  if (panel) visitedPanels.value.add(panel)
  searchController.setSidebarActive(panel === 'search')
}, { immediate: true })
watch(() => [searchScope.value.enabled, searchScope.value.empty, searchScope.value.startLine, searchScope.value.endLine], () => sidebarSearch.invalidate())

/** 本文の世代とカーソルだけを受け取り、解析済みの古い位置を区別する。 */
function onDocumentState(revision: number, head: number): void { documentRevision.value = revision; documentHead.value = head }
/** 履歴画面で完了した操作を簡易一覧へ反映し、本文へフォーカスを戻す。 */
function onHistoryClosed(): void { historyRefreshRevision.value++; focusAfterFileDialog() }
/** 管理画面には現在の所属フォルダーを渡し、記録や送信は自動で実行しない。 */
function openHistoryManagement(root?: string): void { void gitHistory.open(root) }
/** パネルの明示選択では集中モードを解除し、切替以外の文書操作を行わない。 */
function selectSidebar(panel: SidebarPanelId, toggle = true): void {
  if (mainCloseInProgress.value || projectTreeResizing.value) return
  focusMode.value = false
  selectSidebarPanel(panel, toggle)
}

const commandActions: Record<CommandId, () => Promise<void>> = {
  'document.new': newDocument,
  'document.open': openDocument,
  'document.recentFiles': recentFiles.open,
  'document.gitHistory': gitHistory.open,
  'document.quickOpen': async () => { quickOpen.open() },
  'document.save': saveDocument,
  'document.saveAs': saveDocumentAs,
  'edit.find': () => openSearchWindow('search'),
  'edit.replace': () => openSearchWindow('replace'),
  'edit.goToLine': async () => { editor.value?.openLineNavigation() },
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
  'toolbar.typography.fontSizeAdjust': async () => openSettingsWindow('editor.typography'),
  'toolbar.typography.lineHeight': async () => openSettingsWindow('editor.typography'),
  'view.toolbar.toggle': toggleToolbarVisibility,
  'view.whitespace.toggle': settingsController.toggleWhitespace,
  'view.lineNumbers.toggle': settingsController.toggleLineNumbers,
  'view.focusMode.toggle': toggleFocusMode,
  'view.sidebar.toggle': async () => { toggleSidebar() },
  'view.sidebar.project': async () => { selectSidebar('project', false) },
  'view.sidebar.search': async () => { selectSidebar('search', false) },
  'view.sidebar.history': async () => { selectSidebar('history', false) },
  'view.sidebar.outline': async () => { selectSidebar('outline', false) },
  'view.toolbar.customize': async () => openSettingsWindow('appearance.toolbar'),
}
const appCommands = Object.fromEntries(appCommandDefinitions.map((definition) => [definition.id, {
  ...definition,
  execute: commandActions[definition.id],
  isEnabled: () => !isCommandDisabled(definition.id),
  isChecked: () => isCommandChecked(definition.id),
}])) as Record<CommandId, AppCommand>

/** 文書処理中や履歴モーダル内で利用できないコマンドを判定する。 */
function isCommandDisabled(commandId: CommandId): boolean {
  if (mainCloseInProgress.value) return true
  if (gitHistoryOpen.value && (commandId.startsWith('document.') || commandId.startsWith('edit.'))) return true
  if (documentSession.externalDialog.value && (commandId.startsWith('document.') || commandId.startsWith('edit.'))) return true
  if (recentFiles.isOpen.value && (commandId.startsWith('document.') || commandId.startsWith('edit.'))) return true
  if (commandId === 'document.gitHistory') return recentFilesDisabled.value || quickOpen.isOpen.value || sidebarHistory.pending.value || sidebarHistory.exporting.value
  if (commandId === 'document.recentFiles') return recentFilesDisabled.value || quickOpen.isOpen.value
  if (commandId === 'view.focusMode.toggle' || commandId.startsWith('view.sidebar.')) return projectTreeResizing.value
  if (commandId === 'document.quickOpen') return quickOpenDisabled.value
  if (quickOpen.isOpen.value && (commandId.startsWith('document.') || commandId.startsWith('edit.'))) return true
  if (commandId.startsWith('edit.')) return documentLocked.value
  if (commandId.startsWith('toolbar.typography.')) return busy.value || documentLocked.value
  return busy.value && commandId.startsWith('document.')
}

/** 現在選択されている状態付きコマンドかを判定する。 */
function isCommandChecked(commandId: CommandId): boolean {
  if (commandId === 'view.focusMode.toggle') return focusMode.value
  if (commandId === 'view.sidebar.toggle') return !focusMode.value && !projectTreeCollapsed.value
  if (commandId.startsWith('view.sidebar.')) return visibleSidebarPanel.value === commandId.slice('view.sidebar.'.length)
  if (commandId === 'view.lineNumbers.toggle') return editorSettings.value.showLineNumbers
  if (commandId === 'view.whitespace.toggle') return editorSettings.value.showWhitespace
  if (commandId === 'wrap.window') return editorSettings.value.wrapMode === 'window'
  if (commandId === 'wrap.columns') return editorSettings.value.wrapMode === 'columns'
  if (commandId === 'wrap.none') return editorSettings.value.wrapMode === 'none'
  return commandId === 'window.alwaysOnTop' && alwaysOnTop.value
}

/** 保存済みの幅と選択パネルを保持して開閉する。集中モード中は明示して再表示する。 */
function toggleSidebar(): void {
  if (projectTreeResizing.value || mainCloseInProgress.value) return
  if (focusMode.value) { selectSidebar(activeSidebarPanel.value, false); return }
  toggleProjectTreeCollapsed()
}

/** 保存済みの表示設定を変えず周辺UIを隠し、隠れる領域にあるフォーカスだけ本文へ戻す。 */
async function toggleFocusMode(): Promise<void> {
  const previousFocus = document.activeElement
  const focusWillHide = previousFocus instanceof HTMLElement
    && previousFocus.closest('.project-navigation, .toolbar-strip') !== null
  focusMode.value = !focusMode.value
  if (!focusMode.value || !focusWillHide) return
  await nextTick()
  if (focusMode.value && !documentLocked.value && !mainCloseInProgress.value
    && (document.activeElement === previousFocus || document.activeElement === document.body)) {
    editor.value?.focus()
  }
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

/** モーダルの終了アニメーション後に本文へ戻り、文書処理や終了中のフォーカス移動を避ける。 */
function focusAfterFileDialog(): void {
  if (!editorInteractionLocked.value && !mainCloseInProgress.value) editor.value?.focus()
}

/** 終了要求ではGitの実行完了を案内し、保存を完了させてからメイン窓を破棄する。 */
async function handleCloseRequested(): Promise<void> {
  if (gitHistory.pending.value || sidebarHistory.pending.value || sidebarHistory.exporting.value) {
    showPersistenceNotice('Git の処理中です。完了してからもう一度終了してください。')
    return
  }
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
  await appearanceHost.setup()
  if (!isAppLifecycleActive(generation)) return
  await setupProjectController()
  if (!isAppLifecycleActive(generation)) return
  await setupSearchController()
  if (!isAppLifecycleActive(generation)) return
  await setupProjectTreeWindowController()
  if (!isAppLifecycleActive(generation)) return
  const recoveryLoaded = await initializeRecovery()
  if (!isAppLifecycleActive(generation)) return
  await externalFileMonitor.setup()
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
  externalFileMonitor.dispose()
  recentFiles.dispose()
  gitHistory.dispose()
  sidebarSearch.dispose()
  sidebarHistory.dispose()
  appMounted = false
  appLifecycleGeneration += 1
  window.removeEventListener('keydown', onKeydown, true)
  quickOpen.dispose()
  disposeDocumentSession()
  void disposeProjectTreeWindowController()
  disposeMainWindowController()
  void settingsController.dispose()
  appearanceHost.dispose()
  void disposeSearchController()
  disposeProjectController()
})
</script>

<template>
  <VApp class="app-shell" :class="{ 'is-project-tree-resizing': projectTreeResizing }" :style="interfaceBarStyle">
    <MainAppBar
      :menu-height="interfaceBarMetrics.menu.height"
      :toolbar-height="interfaceBarMetrics.toolbar.height"
      :toolbar-visible="displayedToolbarVisible"
      :focus-mode="focusMode"
      :toolbar-items="displayedToolbarItems"
      :editor-settings="editorSettings"
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
      :projects="projectMenuProjects"
      :active-project-id="projectMenuActiveProjectId"
      :project-menu-disabled="projectMenuDisabled"
      @command="executeCommand"
      @toggle-maximize="toggleMaximizeWindow"
      @project-create="requestProjectCreate"
      @project-select="changeMenuProject"
      @project-rename="requestProjectRename"
      @project-delete="requestProjectDelete"
      @adjust-font-size="adjustToolbarFontSize"
      @adjust-line-height="adjustToolbarLineHeight"
    />
    <ProjectNameDialog
      v-model="projectDialogOpen"
      :title="projectDialogTitle"
      :value="projectDialogValue"
      :disabled="projectMenuDisabled"
      @update:value="projectDialogValue = $event"
      @save="projectDialogSave"
    />
    <QuickOpenDialog
      v-model:query="quickOpen.query.value"
      v-model:all-projects="quickOpen.allProjects.value"
      :model-value="quickOpen.isOpen.value"
      :results="quickOpen.results.value"
      :selected-node-id="quickOpen.selectedNodeId.value"
      :pending="quickOpen.pending.value"
      :disabled="quickOpenDisabled"
      :error="quickOpen.error.value"
      :focus-revision="quickOpen.focusRevision.value"
      @update:model-value="quickOpen.close"
      @select="quickOpen.select"
      @move="quickOpen.moveSelection"
      @open-file="quickOpen.openSelected"
      @closed="focusAfterFileDialog"
    />
    <GitHistoryDialog :controller="gitHistory" @closed="onHistoryClosed" />
    <RecentFilesDialog
      :model-value="recentFiles.isOpen.value"
      :entries="recentFiles.entries.value"
      :selected-id="recentFiles.selectedId.value"
      :pending="recentFiles.pending.value"
      :disabled="recentFilesDisabled"
      :error="recentFiles.error.value"
      @close="recentFiles.close"
      @closed="focusAfterFileDialog"
      @select="recentFiles.selectedId.value = $event"
      @move="recentFiles.moveSelection"
      @open-file="recentFiles.openSelected"
      @remove="recentFiles.remove"
    />
    <VSnackbar v-model="persistenceNoticeOpen" timeout="9000" location="bottom">
      {{ persistenceNotice }}
    </VSnackbar>
    <VNavigationDrawer
      :model-value="!focusMode"
      class="project-navigation sidebar-navigation"
      :class="{ 'is-focus-hidden': focusMode, 'is-collapsed': projectTreeVisuallyCollapsed }"
      app
      permanent
      :width="projectTreeDrawerWidth"
      aria-label="執筆サイドバー"
    >
      <SidebarShell :active-panel="activeSidebarPanel" :collapsed="projectTreeVisuallyCollapsed" :disabled="mainCloseInProgress" :resizing="projectTreeResizing" @select="selectSidebar" @close="toggleSidebar">
        <div v-show="activeSidebarPanel === 'project'" id="sidebar-project" :inert="activeSidebarPanel !== 'project'" class="sidebar-panel">
          <ProjectTreeSidebar
            v-if="!projectTreeDetached"
            :disabled="projectTreeWindowDisabled" :document-origin="documentOrigin"
            :expanded-folder-ids="expandedProjectTreeFolderIds" :unavailable-node-ids="projectTreeUnavailableNodeIds" :open-result="projectTreeOpenResult"
            @detach-request="requestProjectTreeDetach" @open-file="openProjectTreeFile" @open-result-applied="consumeProjectTreeOpenResult"
            @origin-detached="detachDocumentOrigin" @expanded-change="updateExpandedProjectTreeFolders" @unavailable-change="updateProjectTreeUnavailableNodeIds"
          />
          <div v-else class="sidebar-inner"><p>プロジェクトは分離ウィンドウに表示しています。</p><VBtn variant="text" :disabled="projectTreeWindowDisabled" @click="openProjectTreeWindow">分離ウィンドウを表示</VBtn><VBtn variant="text" :disabled="projectTreeWindowDisabled" @click="dockProjectTreeWindow">メインへ戻す</VBtn></div>
        </div>
        <div v-if="visitedPanels.has('search')" v-show="activeSidebarPanel === 'search'" id="sidebar-search" :inert="activeSidebarPanel !== 'search'" class="sidebar-panel">
          <SidebarSearchPanel :controller="sidebarSearch" :conditions="searchController.conditions.value" :scope-status="searchScope" :project-name="projectMenuProjects.find(project => project.id === projectMenuActiveProjectId)?.name || ''" :disabled="sidebarDisabled" @conditions="searchController.setSidebarConditions" @clear-scope="editor?.setSearchScope('clear')" />
        </div>
        <div v-if="visitedPanels.has('history')" v-show="activeSidebarPanel === 'history'" id="sidebar-history" :inert="activeSidebarPanel !== 'history'" class="sidebar-panel">
          <SidebarHistoryPanel :controller="sidebarHistory" :path="path" :disabled="sidebarDisabled" @manage="openHistoryManagement" />
        </div>
        <div v-if="visitedPanels.has('outline')" v-show="activeSidebarPanel === 'outline'" id="sidebar-outline" :inert="activeSidebarPanel !== 'outline'" class="sidebar-panel">
          <OutlinePanel :active="visibleSidebarPanel === 'outline'" :editor="editor" :revision="documentRevision" :head="documentHead" :document-key="path" :preferences="settingsController.outline.value" :disabled="sidebarDisabled" @settings="openSettingsWindow('editor.outline')" />
        </div>
      </SidebarShell>
      <div
        class="project-tree-resize-handle"
        role="separator"
        :tabindex="projectTreeVisuallyCollapsed ? -1 : 0"
        aria-label="サイドバーの幅"
        aria-orientation="vertical"
        :aria-valuemin="36"
        :aria-valuemax="projectTreeMaximumWidth"
        :aria-valuenow="projectTreeDrawerWidth"
        :aria-valuetext="projectTreeVisuallyCollapsed ? '閉じています。右へドラッグして開く' : `${projectTreeDrawerWidth}px`"
        @pointerdown="startProjectTreeResize"
        @pointermove="moveProjectTreeResize"
        @pointerup="endProjectTreeResize"
        @pointercancel="cancelProjectTreeResize"
        @lostpointercapture="cancelProjectTreeResize"
        @keydown="onProjectTreeResizeKeydown"
      />
    </VNavigationDrawer>
    <VMain class="writing-area" aria-label="本文編集領域">
      <div class="writing-document">
        <div v-if="documentSession.externalState.value !== 'unchanged'" class="external-file-notice" role="status" :title="documentSession.externalError.value">
          <span>{{ documentSession.externalState.value === 'changed' ? '外部で変更されました。現在の本文は保持しています。' : documentSession.externalState.value === 'missing' ? 'ファイルが見つかりません。現在の本文は保持しています。' : 'ファイルの状態を確認できません。' }}</span>
          <VBtn size="small" variant="text" :disabled="busy || mainCloseInProgress" @click="documentSession.reviewExternalFile">確認する</VBtn>
        </div>
        <EditorPane ref="editor" :settings="editorSettings" :read-only="editorInteractionLocked" @change="onChange" @document-state="onDocumentState" @statistics="statistics = $event" @search-status="onSearchStatus" @search-navigate="onSearchNavigate" @search-scope="onSearchScope" />
      </div>
    </VMain>
    <ExternalFileDialog
      :conflict="documentSession.externalDialog.value" :current-path="path" :pending="busy || mainCloseInProgress"
      @reload="documentSession.reloadExternalFile" @save-as="documentSession.saveDocumentAs"
      @overwrite="documentSession.overwriteExternalFile" @retry="documentSession.reviewExternalFile"
      @later="documentSession.deferExternalFile" @closed="focusAfterFileDialog"
    />
    <VFooter app class="status-bar" :height="interfaceBarMetrics.status.height" @contextmenu="openStatusBarContextMenu">
      <VBtn v-if="searchScope.enabled" size="small" variant="text" :disabled="isCommandDisabled('edit.find')" @click="openSearchWindow('search')">
        {{ searchScope.empty ? '検索範囲を再指定' : '範囲内検索中' }}
      </VBtn>
      <StatisticsStatus
        :statistics="statistics"
        :items="displayedStatusBarItems"
        :editor-settings="editorSettings"
      />
    </VFooter>
    <VMenu v-model="statusBarContextMenuOpen" :target="statusBarContextMenuTarget" location="bottom start" :close-on-content-click="true">
      <VList density="compact" min-width="240" role="menu" aria-label="ステータスバー操作">
        <VListItem role="menuitem" title="ステータスバーをカスタマイズ…" @click="openStatusBarSettings" />
      </VList>
    </VMenu>
  </VApp>
</template>
