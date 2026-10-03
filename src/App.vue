<script setup lang="ts">
// 各Controllerを組み合わせ、横断処理とメイン画面のレイアウト配置を担う。
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { message } from '@tauri-apps/plugin-dialog'
import EditorPane from './EditorPane.vue'
import ProjectTreeSidebar from './ProjectTreeSidebar.vue'
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
const projectTreeContent = ref<HTMLElement | null>(null)
// Tooltipのactivator用refと競合しないよう、ボタンの親DOMを保持する。
const projectTreeToggle = ref<HTMLElement | null>(null)
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
    if (quickOpenController?.receiveOpenResult(result)) projectTreeController.consumeProjectTreeOpenResult(result.requestId)
  },
})
const gitHistory = useGitHistoryController({
  isOpen: gitHistoryOpen,
  disabled: computed(() => documentSession.busy.value || mainCloseInProgress.value || !!documentSession.externalDialog.value),
  path: documentSession.path,
  dirty: documentSession.dirty,
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

// 非表示のDOM更新より先に、隠れる内容や境界のフォーカスを開閉ボタンへ移す。
watch(projectTreeVisuallyCollapsed, (collapsed) => {
  if (!collapsed || focusMode.value || projectTreeDetached.value || mainCloseInProgress.value) return
  const active = document.activeElement
  if (projectTreeContent.value?.contains(active)
    || (active instanceof HTMLElement && active.classList.contains('project-tree-resize-handle'))) {
    projectTreeToggle.value?.querySelector<HTMLButtonElement>('button')?.focus()
  }
}, { flush: 'sync' })
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
  if (commandId === 'document.gitHistory') return recentFilesDisabled.value || quickOpen.isOpen.value
  if (commandId === 'document.recentFiles') return recentFilesDisabled.value || quickOpen.isOpen.value
  if (commandId === 'view.focusMode.toggle') return projectTreeResizing.value
  if (commandId === 'document.quickOpen') return quickOpenDisabled.value
  if (quickOpen.isOpen.value && (commandId.startsWith('document.') || commandId.startsWith('edit.'))) return true
  if (commandId.startsWith('edit.')) return documentLocked.value
  if (commandId.startsWith('toolbar.typography.')) return busy.value || documentLocked.value
  return busy.value && commandId.startsWith('document.')
}

/** 現在選択されている状態付きコマンドかを判定する。 */
function isCommandChecked(commandId: CommandId): boolean {
  if (commandId === 'view.focusMode.toggle') return focusMode.value
  if (commandId === 'view.lineNumbers.toggle') return editorSettings.value.showLineNumbers
  if (commandId === 'view.whitespace.toggle') return editorSettings.value.showWhitespace
  if (commandId === 'wrap.window') return editorSettings.value.wrapMode === 'window'
  if (commandId === 'wrap.columns') return editorSettings.value.wrapMode === 'columns'
  if (commandId === 'wrap.none') return editorSettings.value.wrapMode === 'none'
  return commandId === 'window.alwaysOnTop' && alwaysOnTop.value
}

/** ツリー内のフォーカスを開閉ボタンへ移し、内容と幅を保持して開閉する。 */
function toggleProjectTree(): void {
  if (focusMode.value || projectTreeDetached.value || projectTreeResizing.value || mainCloseInProgress.value) return
  if (!projectTreeCollapsed.value && projectTreeContent.value?.contains(document.activeElement)) {
    projectTreeToggle.value?.querySelector<HTMLButtonElement>('button')?.focus()
  }
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
  if (gitHistory.pending.value) {
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
    <GitHistoryDialog :controller="gitHistory" @closed="focusAfterFileDialog" />
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
      v-if="!projectTreeDetached"
      :model-value="!focusMode"
      class="project-navigation"
      :class="{ 'is-focus-hidden': focusMode }"
      app
      permanent
      :width="projectTreeDrawerWidth"
      aria-label="プロジェクトツリー"
    >
      <div ref="projectTreeToggle" class="project-tree-toggle-row">
        <VTooltip :text="projectTreeVisuallyCollapsed ? 'プロジェクトツリーを開く' : 'プロジェクトツリーを閉じる'" :disabled="focusMode || projectTreeResizing" location="right">
          <template #activator="{ props: toggleProps }">
            <VBtn
              v-bind="toggleProps"
              class="project-tree-toggle"
              variant="text"
              :icon="projectTreeVisuallyCollapsed ? 'mdi-chevron-right' : 'mdi-chevron-left'"
              :aria-label="projectTreeVisuallyCollapsed ? 'プロジェクトツリーを開く' : 'プロジェクトツリーを閉じる'"
              :aria-expanded="!projectTreeVisuallyCollapsed"
              aria-controls="project-tree-content"
              :disabled="mainCloseInProgress"
              :aria-disabled="projectTreeResizing || mainCloseInProgress"
              @click="toggleProjectTree"
            />
          </template>
        </VTooltip>
      </div>
      <div v-show="!projectTreeVisuallyCollapsed" id="project-tree-content" ref="projectTreeContent" class="project-tree-content">
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
      </div>
      <div
        class="project-tree-resize-handle"
        role="separator"
        :tabindex="projectTreeVisuallyCollapsed ? -1 : 0"
        aria-label="プロジェクトツリーの幅"
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
        <EditorPane ref="editor" :settings="editorSettings" :read-only="editorInteractionLocked" @change="onChange" @statistics="statistics = $event" @search-status="onSearchStatus" @search-navigate="onSearchNavigate" @search-scope="onSearchScope" />
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
