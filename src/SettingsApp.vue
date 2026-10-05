<script setup lang="ts">
// 設定ページを切り替えながら編集し、変更を共通経路へ反映して自動保存する。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getCurrentWindow, type CloseRequestedEvent } from '@tauri-apps/api/window'
import OutlineSettingsPage from './OutlineSettingsPage.vue'
import { createDefaultOutline } from './outline'
import ToolbarSettingsPage from './ToolbarSettingsPage.vue'
import WrappingSettingsPage from './WrappingSettingsPage.vue'
import TypographySettingsPage from './TypographySettingsPage.vue'
import StorageSettingsPage from './StorageSettingsPage.vue'
import BarSizeSettingsPage from './BarSizeSettingsPage.vue'
import StatusBarSettingsPage from './StatusBarSettingsPage.vue'
import AppearanceSettingsPage from './AppearanceSettingsPage.vue'
import {
  resetToolbarPreferences,
  resetStatusBarPreferences,
  resetInterfaceBarSizes,
  type InterfaceBarSizes,
  type StatusBarItemId,
  type StatusBarPreferences,
  type ToolbarItem,
  type ToolbarPreferences,
} from './appPreferenceSchema'
import {
  defaultEditorSettings,
  type EditorSettings,
} from './editorSettings'
import {
  type SettingsSnapshot,
} from './settingsSession'
import {
  allSettingsSectionIds,
  settingsCategoryDefinitions,
  settingsAllViewDefinition,
  settingsPageDefinitions,
  settingsPageLabels,
  settingsSectionDefinitions,
  type SettingsCategoryId,
  type SettingsSectionId,
  type SettingsViewId,
} from './settingsDefinitions'
import { useEditorSettingsDrafts } from './useEditorSettingsDrafts'
import { useSettingsWindowChannel } from './useSettingsWindowChannel'
import { useChildAppearance } from './useChildAppearance'

useChildAppearance()

let receiveChannelSnapshot: (nextSnapshot: SettingsSnapshot) => void = () => {}
const settingsChannel = useSettingsWindowChannel({
  onSnapshot: (nextSnapshot) => receiveChannelSnapshot(nextSnapshot),
})
const { snapshot, errorMessage, sendCommand } = settingsChannel
let removeCloseListener: (() => void) | undefined
let closing = false, allowClose = false

/** 設定窓を閉じる前に保留入力のメイン側反映を確認し、確認できない場合は窓を残す。 */
async function onCloseRequested(event: CloseRequestedEvent): Promise<void> {
  if (allowClose) return
  event.preventDefault()
  if (closing) return
  closing = true
  try { await settingsChannel.flush(); allowClose = true; await getCurrentWindow().close() }
  catch (error) { allowClose = false; errorMessage.value = String(error) }
  finally { closing = false }
}

/** ピッカー確定時に最終色を送り、通信失敗を画面内へ表示する。 */
function flushColors(): void { void settingsChannel.flushColors().catch(error => { errorMessage.value = String(error) }) }
const activeView = ref<SettingsViewId>('editor.wrapping')
const openedGroups = ref(['editor', 'appearance', 'application'])
const openedSectionIds = ref<SettingsSectionId[]>([...allSettingsSectionIds])
const toolbarDragResetRevision = ref(0)
const statusBarDragResetRevision = ref(0)
const toolbarResetDialog = ref(false)
const statusBarResetDialog = ref(false)
const allResetDialog = ref(false)
const resetDialogOpen = computed(() => toolbarResetDialog.value || statusBarResetDialog.value || allResetDialog.value)
const errorSnackbarOpen = computed({
  get: () => errorMessage.value.length > 0,
  set: (value: boolean) => { if (!value) errorMessage.value = '' },
})
const settingsPagesByCategory = computed<Record<SettingsCategoryId, typeof settingsPageDefinitions[number][]>>(() => ({
  editor: settingsPageDefinitions.filter((page) => page.categoryId === 'editor'),
  appearance: settingsPageDefinitions.filter((page) => page.categoryId === 'appearance'),
  application: settingsPageDefinitions.filter((page) => page.categoryId === 'application'),
}))

const visiblePageDefinitions = computed(() => {
  if (!snapshot.value) return []
  const pages = activeView.value === 'all'
    ? [...settingsPageDefinitions]
    : settingsPageDefinitions.filter((page) => page.id === activeView.value)
  let previousCategory: SettingsCategoryId | null = null

  return pages.map((page) => {
    const showCategoryHeading = activeView.value === 'all' && page.categoryId !== previousCategory
    previousCategory = page.categoryId
    return {
      ...page,
      showCategoryHeading,
      categoryLabel: settingsCategoryDefinitions.find((category) => category.id === page.categoryId)?.label ?? '',
      sections: settingsSectionDefinitions.filter((section) => section.pageId === page.id),
    }
  })
})

const allSectionsExpanded = computed(() =>
  allSettingsSectionIds.length > 0 && allSettingsSectionIds.every((sectionId) => openedSectionIds.value.includes(sectionId)),
)
const allSectionsCollapsed = computed(() => !allSettingsSectionIds.some((sectionId) => openedSectionIds.value.includes(sectionId)))

/** 「すべて表示」の全セクションを一度に展開する。 */
function expandAllSections(): void {
  openedSectionIds.value = [...allSettingsSectionIds]
}

/** 「すべて表示」の全セクションを一度に折りたたむ。 */
function collapseAllSections(): void {
  openedSectionIds.value = []
}

/** 指定セクションの開閉状態をセッション内の共通状態へ反映する。 */
function toggleSection(sectionId: SettingsSectionId, expanded: boolean): void {
  const sectionIds = new Set(openedSectionIds.value)
  if (expanded) sectionIds.add(sectionId)
  else sectionIds.delete(sectionId)
  openedSectionIds.value = [...sectionIds]
}

watch(activeView, () => {
  toolbarDragResetRevision.value += 1
  statusBarDragResetRevision.value += 1
})
watch(openedSectionIds, (sectionIds) => {
  if (!sectionIds.includes('appearance.toolbar.configuration')) toolbarDragResetRevision.value += 1
  if (!sectionIds.includes('appearance.statusBar.configuration')) statusBarDragResetRevision.value += 1
})

const {
  columnsValue,
  columnsInput,
  columnError,
  typographyValues,
  typographyInputs,
  typographyErrors,
  hasInputError,
  onColumnsInput,
  onColumnsValue,
  onColumnsInteraction,
  commitColumnsInput,
  onTypographyInput,
  onTypographyValue,
  onTypographyInteraction,
  commitTypographyInput,
  restoreField,
  resetDrafts,
  receiveSettingsSnapshot: syncSettingsSnapshot,
} = useEditorSettingsDrafts({ snapshot, sendCommand })

receiveChannelSnapshot = (nextSnapshot: SettingsSnapshot): void => {
  if (syncSettingsSnapshot(nextSnapshot)) activeView.value = nextSnapshot.page
}

/** 指定表示先へ移動し、メイン画面にも選択状態を共有する。 */
function selectView(page: SettingsViewId): void {
  activeView.value = page
  void sendCommand({ type: 'navigate', page })
}

/** 本文設定の部分変更を共通の自動保存経路へ送る。 */
function changeEditor(value: Partial<EditorSettings>): void {
  if (!snapshot.value) return
  void sendCommand({ type: 'change', editor: value })
}

/** ツールバーの現在値を画面へ反映し、自動保存要求へ送る。 */
function changeToolbar(value: Partial<ToolbarPreferences> & { items?: ToolbarItem[] }, flush = false): void {
  if (!snapshot.value) return
  snapshot.value = {
    ...snapshot.value,
    toolbar: {
      ...snapshot.value.toolbar,
      ...value,
      items: value.items ? value.items.map((item) => ({ ...item })) : snapshot.value.toolbar.items,
    },
  }
  void sendCommand({ type: 'change', toolbar: value, flush })
}

/** ステータスバーの現在値を画面へ反映し、自動保存要求へ送る。 */
function changeStatusBar(value: Partial<StatusBarPreferences> & { items?: StatusBarItemId[] }, flush = false): void {
  if (!snapshot.value) return
  snapshot.value = {
    ...snapshot.value,
    statusBar: {
      ...snapshot.value.statusBar,
      ...value,
      items: value.items ? [...value.items] : snapshot.value.statusBar.items,
    },
  }
  void sendCommand({ type: 'change', statusBar: value, flush })
}

/** 各バーのサイズを画面へ反映し、共通のUndo・自動保存経路へ送る。 */
function changeBarSizes(value: Partial<InterfaceBarSizes>, flush = false): void {
  if (!snapshot.value) return
  snapshot.value = {
    ...snapshot.value,
    barSizes: {
      ...snapshot.value.barSizes,
      ...value,
    },
  }
  void sendCommand({ type: 'change', barSizes: value, flush })
}

/** ツールバー初期化の確認画面を開く。 */
function restoreToolbarDefaults(): void {
  toolbarResetDialog.value = true
}

/** 確認後にツールバー構成を初期値へ戻して即時保存する。 */
function confirmToolbarDefaults(): void {
  toolbarResetDialog.value = false
  if (!snapshot.value) return
  const toolbar = resetToolbarPreferences(snapshot.value.toolbar)
  changeToolbar({ items: toolbar.items }, true)
}

/** ステータスバー初期化の確認画面を開く。 */
function restoreStatusBarDefaults(): void {
  statusBarResetDialog.value = true
}

/** 確認後にステータスバー構成を初期値へ戻して即時保存する。 */
function confirmStatusBarDefaults(): void {
  statusBarResetDialog.value = false
  if (!snapshot.value) return
  const statusBar = resetStatusBarPreferences()
  changeStatusBar({ items: statusBar.items }, true)
}

/** 全設定初期化の確認画面を開く。 */
function restoreAllDefaults(): void {
  allResetDialog.value = true
}

/** 確認後に全設定を初期値へ戻し、1回の更新として即時保存する。 */
function confirmAllDefaults(): void {
  allResetDialog.value = false
  if (!snapshot.value) return
  const toolbar = { ...resetToolbarPreferences(snapshot.value.toolbar), visible: true }
  const statusBar = resetStatusBarPreferences()
  const barSizes = resetInterfaceBarSizes()
  resetDrafts()
  snapshot.value = {
    ...snapshot.value,
    editor: { ...defaultEditorSettings },
    toolbar,
    statusBar,
    barSizes,
  }
  void sendCommand({
    type: 'change',
    editor: { ...defaultEditorSettings },
    toolbar,
    statusBar,
    barSizes,
    flush: true,
    resetAppearance: true,
    outline: createDefaultOutline(),
  })
}

/** 入力欄ではブラウザー標準の文字編集Undo／Redoを優先する。 */
function isTextEditingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') !== null
  )
}

/** 設定画面内のCtrlショートカットから共有Undo／Redo履歴を操作する。 */
function onKeydown(event: KeyboardEvent): void {
  if (activeView.value === 'application.storage') return
  if (!event.ctrlKey || event.altKey || event.isComposing || isTextEditingTarget(event.target)) return
  if (resetDialogOpen.value) return

  const key = event.key.toLowerCase()
  const isUndo = key === 'z' && !event.shiftKey
  const isRedo = key === 'y' && !event.shiftKey || key === 'z' && event.shiftKey
  if (!isUndo && !isRedo) return

  event.preventDefault()
  if (isUndo && snapshot.value?.history.canUndo) void sendCommand({ type: 'undo' })
  if (isRedo && snapshot.value?.history.canRedo) void sendCommand({ type: 'redo' })
}

// メインウィンドウの状態を受け取れるようにしてから、現在値を要求する。
onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await settingsChannel.setup()
  removeCloseListener = await getCurrentWindow().onCloseRequested(onCloseRequested)
  await sendCommand({ type: 'ready' })
})

// 設定ウィンドウを破棄する際に状態イベントの購読を解除する。
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  removeCloseListener?.()
  settingsChannel.dispose()
})
</script>

<template>
  <VApp class="settings-shell">
    <VAppBar flat>
      <VToolbarTitle v-if="snapshot" id="settings-page-heading" tag="h1">
        {{ activeView === 'all' ? settingsAllViewDefinition.label : settingsPageLabels[activeView] }}
      </VToolbarTitle>
      <template #append>
        <div class="settings-history-actions" role="group" aria-label="設定変更の履歴">
          <VTooltip text="元に戻す（Ctrl+Z）" location="bottom">
            <template #activator="{ props }">
              <span v-bind="props" class="settings-history-tooltip-activator">
                <VBtn
                  icon="mdi-undo"
                  variant="text"
                  :disabled="!snapshot?.history.canUndo || activeView === 'application.storage' || resetDialogOpen"
                  aria-label="元に戻す"
                  aria-keyshortcuts="Control+Z"
                  @click="sendCommand({ type: 'undo' })"
                />
              </span>
            </template>
          </VTooltip>
          <VTooltip text="やり直す（Ctrl+Y / Ctrl+Shift+Z）" location="bottom">
            <template #activator="{ props }">
              <span v-bind="props" class="settings-history-tooltip-activator">
                <VBtn
                  icon="mdi-redo"
                  variant="text"
                  :disabled="!snapshot?.history.canRedo || activeView === 'application.storage' || resetDialogOpen"
                  aria-label="やり直す"
                  aria-keyshortcuts="Control+Y Control+Shift+Z"
                  @click="sendCommand({ type: 'redo' })"
                />
              </span>
            </template>
          </VTooltip>
        </div>
      </template>
    </VAppBar>
    <VNavigationDrawer permanent width="236" class="settings-navigation">
      <VList v-model:opened="openedGroups" nav density="compact" aria-label="設定項目">
        <VListItem
          :active="activeView === 'all'"
          :title="settingsAllViewDefinition.label"
          :prepend-icon="settingsAllViewDefinition.icon"
          :aria-current="activeView === 'all' ? 'page' : undefined"
          @click="selectView('all')"
        >
          <template #append>
            <VChip v-if="hasInputError" color="error" size="x-small" variant="tonal" aria-label="設定の入力エラーがあります">入力エラー</VChip>
          </template>
        </VListItem>
        <VListGroup v-for="category in settingsCategoryDefinitions" :key="category.id" :value="category.id">
          <template #activator="{ props }">
            <VListItem v-bind="props" :title="category.label" :prepend-icon="category.icon" />
          </template>
          <VListItem
            v-for="page in settingsPagesByCategory[category.id]"
            :key="page.id"
            :active="activeView === page.id"
            :title="page.label"
            :aria-current="activeView === page.id ? 'page' : undefined"
            @click="selectView(page.id)"
          >
            <template #append>
              <VChip v-if="page.id === 'editor.wrapping' && columnError || page.id === 'editor.typography' && (typographyErrors.fontSize || typographyErrors.lineHeight)" color="error" size="x-small" variant="tonal" aria-label="設定の入力エラーがあります">入力エラー</VChip>
            </template>
          </VListItem>
        </VListGroup>
      </VList>
      <div class="settings-navigation-footer">
        <VBtn block variant="text" prepend-icon="mdi-restore" :disabled="!snapshot" @click="restoreAllDefaults">すべて初期値に戻す</VBtn>
      </div>
    </VNavigationDrawer>
    <VMain class="settings-main">
      <VContainer v-if="snapshot" class="settings-content" fluid>
        <div v-if="activeView === 'all'" class="settings-expand-actions" role="group" aria-label="設定セクションの表示">
          <VBtn size="small" variant="text" prepend-icon="mdi-unfold-more-horizontal" :disabled="allSectionsExpanded" @click="expandAllSections">すべて展開</VBtn>
          <VBtn size="small" variant="text" prepend-icon="mdi-unfold-less-horizontal" :disabled="allSectionsCollapsed" @click="collapseAllSections">すべて折りたたむ</VBtn>
        </div>
        <template v-for="page in visiblePageDefinitions" :key="page.id">
          <h2 v-if="page.showCategoryHeading" class="settings-category-heading">{{ page.categoryLabel }}</h2>
          <h3 v-if="activeView === 'all'" class="settings-page-heading">{{ page.label }}</h3>
          <WrappingSettingsPage
            v-if="page.id === 'editor.wrapping'"
            :key="`${page.id}-${activeView}`"
            :editor="snapshot.editor"
            :columns-value="columnsValue"
            :columns-input="columnsInput"
            :column-error="columnError"
            :heading-level="activeView === 'all' ? 4 : 2"
            :sections="page.sections"
            :expanded-section-ids="openedSectionIds"
            @update-editor="changeEditor"
            @columns-input="onColumnsInput"
            @columns-value="onColumnsValue"
            @columns-commit="commitColumnsInput"
            @columns-interaction="onColumnsInteraction"
            @restore-field="restoreField"
            @toggle-section="toggleSection"
          />
          <TypographySettingsPage
            v-else-if="page.id === 'editor.typography'"
            :key="`${page.id}-${activeView}`"
            :editor="snapshot.editor" :values="typographyValues" :inputs="typographyInputs" :errors="typographyErrors"
            :heading-level="activeView === 'all' ? 4 : 2" :sections="page.sections" :expanded-section-ids="openedSectionIds"
            @update-editor="changeEditor" @number-input="onTypographyInput" @number-value="onTypographyValue" @number-commit="commitTypographyInput" @number-interaction="onTypographyInteraction"
            @restore-field="restoreField" @toggle-section="toggleSection"
          />
          <OutlineSettingsPage v-else-if="page.id === 'editor.outline'" :preferences="snapshot.outline" @change="sendCommand({ type: 'change', outline: $event })" />
          <AppearanceSettingsPage
            v-else-if="page.id === 'appearance.colors'"
            :appearance="snapshot.appearance" :epoch="snapshot.appearanceEpoch" :file-busy="snapshot.appearanceFileBusy" :suspended="resetDialogOpen || closing" :target-reset-key="activeView"
            :heading-level="activeView === 'all' ? 4 : 2" :sections="page.sections" :expanded-section-ids="openedSectionIds"
            @command="sendCommand" @flush-colors="flushColors" @toggle-section="toggleSection"
          />
          <ToolbarSettingsPage
            v-else-if="page.id === 'appearance.toolbar'"
            :toolbar="snapshot.toolbar"
            :heading-level="activeView === 'all' ? 4 : 2"
            :sections="page.sections"
            :expanded-section-ids="openedSectionIds"
            :drag-reset-revision="toolbarDragResetRevision"
            @update-toolbar="changeToolbar"
            @reset-toolbar="restoreToolbarDefaults"
            @toggle-section="toggleSection"
          />
          <StatusBarSettingsPage
            v-else-if="page.id === 'appearance.statusBar'"
            :key="`${page.id}-${activeView}`"
            :status-bar="snapshot.statusBar"
            :heading-level="activeView === 'all' ? 4 : 2"
            :sections="page.sections"
            :expanded-section-ids="openedSectionIds"
            :drag-reset-revision="statusBarDragResetRevision"
            @update-status-bar="changeStatusBar"
            @reset-status-bar="restoreStatusBarDefaults"
            @toggle-section="toggleSection"
          />
          <BarSizeSettingsPage
            v-else-if="page.id === 'appearance.bars'"
            :key="`${page.id}-${activeView}`"
            :bar-sizes="snapshot.barSizes"
            :heading-level="activeView === 'all' ? 4 : 2"
            :sections="page.sections"
            :expanded-section-ids="openedSectionIds"
            @update-bar-sizes="changeBarSizes"
            @toggle-section="toggleSection"
          />
          <StorageSettingsPage
            v-else-if="page.id === 'application.storage'"
            :heading-level="activeView === 'all' ? 4 : 2"
            :sections="page.sections"
            :expanded-section-ids="openedSectionIds"
            @toggle-section="toggleSection"
          />
        </template>
      </VContainer>
      <VContainer v-else>
        <VAlert type="info" variant="tonal">設定を読み込んでいます。</VAlert>
      </VContainer>
    </VMain>
    <VDialog v-model="toolbarResetDialog" max-width="440">
      <VCard title="ツールバーを初期状態に戻しますか？">
        <VCardText>ツールバーの構成と順序を初期状態に変更し、自動保存します。</VCardText>
        <VCardActions>
          <VSpacer />
          <VBtn variant="text" @click="toolbarResetDialog = false">戻る</VBtn>
          <VBtn color="primary" @click="confirmToolbarDefaults">初期状態に戻す</VBtn>
        </VCardActions>
      </VCard>
    </VDialog>
    <VDialog v-model="statusBarResetDialog" max-width="440">
      <VCard title="ステータスバーを初期状態に戻しますか？">
        <VCardText>ステータスバーの表示項目と順序を初期状態に変更し、自動保存します。</VCardText>
        <VCardActions>
          <VSpacer />
          <VBtn variant="text" @click="statusBarResetDialog = false">戻る</VBtn>
          <VBtn color="primary" @click="confirmStatusBarDefaults">初期状態に戻す</VBtn>
        </VCardActions>
      </VCard>
    </VDialog>
    <VDialog v-model="allResetDialog" max-width="440">
      <VCard title="すべての設定を初期値に戻しますか？">
        <VCardText>本文表示、折り返し、見出し判定、ツールバー、ステータスバー、各バーのサイズ、現在の配色を初期値へ変更し、自動保存します。保存済みの配色プリセットとデータ保存先は変更しません。</VCardText>
        <VCardActions>
          <VSpacer />
          <VBtn variant="text" @click="allResetDialog = false">戻る</VBtn>
          <VBtn color="primary" @click="confirmAllDefaults">すべて初期値に戻す</VBtn>
        </VCardActions>
      </VCard>
    </VDialog>
    <VSnackbar v-model="errorSnackbarOpen" timeout="9000" location="bottom" role="alert">
      {{ errorMessage }}
      <template #actions>
        <VBtn variant="text" @click="errorMessage = ''">閉じる</VBtn>
      </template>
    </VSnackbar>
  </VApp>
</template>
