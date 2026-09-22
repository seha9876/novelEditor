<script setup lang="ts">
// 設定ページを切り替えながら編集し、確定した変更を共通経路で自動保存する。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import ToolbarSettingsPage from './ToolbarSettingsPage.vue'
import WrappingSettingsPage from './WrappingSettingsPage.vue'
import {
  createDefaultToolbarItems,
  type ToolbarItem,
  type ToolbarPreferences,
} from './appPreferences'
import {
  defaultEditorSettings,
  type EditorSettings,
} from './editorSettings'
import {
  SETTINGS_COMMAND_EVENT,
  SETTINGS_ERROR_EVENT,
  SETTINGS_STATE_EVENT,
  type SettingsCommand,
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

const snapshot = ref<SettingsSnapshot | null>(null)
const columnsInput = ref(String(defaultEditorSettings.wrapColumns))
const columnsInputDirty = ref(false)
const errorMessage = ref('')
const activeView = ref<SettingsViewId>('editor.wrapping')
const openedGroups = ref(['editor', 'appearance'])
const openedSectionIds = ref<SettingsSectionId[]>([...allSettingsSectionIds])
const toolbarDragResetRevision = ref(0)
const toolbarResetDialog = ref(false)
const allResetDialog = ref(false)
const columnError = computed(() => {
  const columns = Number(columnsInput.value)
  return /^[1-9]\d*$/.test(columnsInput.value) && Number.isInteger(columns) && columns <= 500
    ? ''
    : '1～500の整数を入力してください。変更は保存されていません。'
})
const errorSnackbarOpen = computed({
  get: () => errorMessage.value.length > 0,
  set: (value: boolean) => { if (!value) errorMessage.value = '' },
})
let unlistenState: (() => void) | undefined
let unlistenError: (() => void) | undefined
let lastSnapshotRevision = -1

const settingsPagesByCategory = computed<Record<SettingsCategoryId, typeof settingsPageDefinitions[number][]>>(() => ({
  editor: settingsPageDefinitions.filter((page) => page.categoryId === 'editor'),
  appearance: settingsPageDefinitions.filter((page) => page.categoryId === 'appearance'),
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
const hasInputError = computed(() => columnError.value.length > 0)

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
})
watch(openedSectionIds, (sectionIds) => {
  if (!sectionIds.includes('appearance.toolbar.configuration')) toolbarDragResetRevision.value += 1
})

/** 設定変更やページ移動をメインウィンドウへ送る。 */
async function sendCommand(command: SettingsCommand): Promise<void> {
  errorMessage.value = ''
  try {
    await emitTo('main', SETTINGS_COMMAND_EVENT, command)
  } catch (error) {
    errorMessage.value = String(error)
  }
}

/** 指定表示先へ移動し、メイン画面にも選択状態を共有する。 */
function selectView(page: SettingsViewId): void {
  activeView.value = page
  void sendCommand({ type: 'navigate', page })
}

/** 折り返し設定の部分変更を共通の自動保存経路へ送る。 */
function changeEditor(value: Partial<EditorSettings>): void {
  if (!snapshot.value) return
  void sendCommand({ type: 'change', editor: value })
}

/** 指定桁数の入力途中の文字列を保持し、確定処理はblurまたはEnterまで待つ。 */
function onColumnsInput(value: string | number | null): void {
  columnsInput.value = value === null ? '' : String(value)
  columnsInputDirty.value = true
}

/** 有効な指定桁数だけを現在値へ反映し、すぐに永続化する。 */
function commitColumnsInput(): void {
  if (!snapshot.value || !columnsInputDirty.value || columnError.value) return
  const wrapColumns = Number(columnsInput.value)
  columnsInput.value = String(wrapColumns)
  columnsInputDirty.value = false
  void sendCommand({ type: 'change', editor: { wrapColumns }, flush: true })
}

/** 個別設定を対応する初期値へ戻し、自動保存する。 */
function restoreField(field: keyof EditorSettings): void {
  if (!snapshot.value) return
  if (field === 'wrapColumns') {
    columnsInput.value = String(defaultEditorSettings.wrapColumns)
    columnsInputDirty.value = false
  }
  void sendCommand({ type: 'change', editor: { [field]: defaultEditorSettings[field] } })
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

/** ツールバー初期化の確認画面を開く。 */
function restoreToolbarDefaults(): void {
  toolbarResetDialog.value = true
}

/** 確認後にツールバー構成を初期値へ戻して即時保存する。 */
function confirmToolbarDefaults(): void {
  toolbarResetDialog.value = false
  changeToolbar({ items: createDefaultToolbarItems() }, true)
}

/** 全設定初期化の確認画面を開く。 */
function restoreAllDefaults(): void {
  allResetDialog.value = true
}

/** 確認後に全設定を初期値へ戻し、1回の更新として即時保存する。 */
function confirmAllDefaults(): void {
  allResetDialog.value = false
  if (!snapshot.value) return
  const toolbar = { visible: true, items: createDefaultToolbarItems() }
  snapshot.value = {
    ...snapshot.value,
    editor: { ...defaultEditorSettings },
    toolbar,
  }
  columnsInput.value = String(defaultEditorSettings.wrapColumns)
  columnsInputDirty.value = false
  void sendCommand({
    type: 'change',
    editor: { ...defaultEditorSettings },
    toolbar,
    flush: true,
  })
}

/** 新しい状態をrevision順に受け取り、編集中の入力文字列を維持する。 */
function receiveSettingsSnapshot(nextSnapshot: SettingsSnapshot): void {
  if (nextSnapshot.revision < lastSnapshotRevision) return
  lastSnapshotRevision = nextSnapshot.revision
  const previousSnapshot = snapshot.value
  const editorValueChanged = previousSnapshot !== null &&
    previousSnapshot.editor.wrapColumns !== nextSnapshot.editor.wrapColumns
  snapshot.value = nextSnapshot
  activeView.value = nextSnapshot.page
  if (!previousSnapshot || editorValueChanged) {
    columnsInput.value = String(nextSnapshot.editor.wrapColumns)
    columnsInputDirty.value = false
  }
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
  if (!event.ctrlKey || event.altKey || event.isComposing || isTextEditingTarget(event.target)) return
  if (toolbarResetDialog.value || allResetDialog.value) return

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
  unlistenState = await listen<SettingsSnapshot>(SETTINGS_STATE_EVENT, (event) => {
    receiveSettingsSnapshot(event.payload)
  })
  unlistenError = await listen<string>(SETTINGS_ERROR_EVENT, (event) => {
    errorMessage.value = event.payload
  })
  await sendCommand({ type: 'ready' })
})

// 設定ウィンドウを破棄する際に状態イベントの購読を解除する。
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unlistenState?.()
  unlistenError?.()
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
                  :disabled="!snapshot?.history.canUndo"
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
                  :disabled="!snapshot?.history.canRedo"
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
            <VChip v-if="hasInputError" color="error" size="x-small" variant="tonal" aria-label="指定桁数に入力エラーがあります">入力エラー</VChip>
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
              <VChip v-if="page.id === 'editor.wrapping' && hasInputError" color="error" size="x-small" variant="tonal" aria-label="指定桁数に入力エラーがあります">入力エラー</VChip>
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
            :editor="snapshot.editor"
            :columns-input="columnsInput"
            :column-error="columnError"
            :heading-level="activeView === 'all' ? 4 : 2"
            :sections="page.sections"
            :expanded-section-ids="openedSectionIds"
            @update-editor="changeEditor"
            @columns-input="onColumnsInput"
            @columns-commit="commitColumnsInput"
            @restore-field="restoreField"
            @toggle-section="toggleSection"
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
    <VDialog v-model="allResetDialog" max-width="440">
      <VCard title="すべての設定を初期値に戻しますか？">
        <VCardText>折り返し設定とツールバー設定を初期値へ変更し、自動保存します。</VCardText>
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
