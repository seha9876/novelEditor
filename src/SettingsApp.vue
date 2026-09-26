<script setup lang="ts">
// 設定ページを切り替えながら編集し、変更を共通経路へ反映して自動保存する。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import ToolbarSettingsPage from './ToolbarSettingsPage.vue'
import WrappingSettingsPage from './WrappingSettingsPage.vue'
import TypographySettingsPage from './TypographySettingsPage.vue'
import StorageSettingsPage from './StorageSettingsPage.vue'
import BarSizeSettingsPage from './BarSizeSettingsPage.vue'
import {
  resetToolbarPreferences,
  resetInterfaceBarSizes,
  type ToolbarItem,
  type ToolbarPreferences,
  type InterfaceBarSizes,
} from './appPreferences'
import {
  defaultEditorSettings,
  isValidTypographyNumber,
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
const columnsValue = ref(defaultEditorSettings.wrapColumns)
const columnsInput = ref(String(defaultEditorSettings.wrapColumns))
const columnsInputDirty = ref(false)
let columnsPendingValue: number | null = null
const typographyFields = ['fontSize', 'lineHeight'] as const
type TypographyField = typeof typographyFields[number]
const typographyValues = ref({ fontSize: defaultEditorSettings.fontSize, lineHeight: defaultEditorSettings.lineHeight })
const typographyInputs = ref({ fontSize: String(defaultEditorSettings.fontSize), lineHeight: String(defaultEditorSettings.lineHeight) })
const typographyDirty = { fontSize: false, lineHeight: false }
const typographyPendingValues: Record<TypographyField, number | null> = { fontSize: null, lineHeight: null }
const typographyErrors = computed(() => ({
  fontSize: typographyInputError('fontSize'),
  lineHeight: typographyInputError('lineHeight'),
}))
const errorMessage = ref('')
const activeView = ref<SettingsViewId>('editor.wrapping')
const openedGroups = ref(['editor', 'appearance', 'application'])
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
const hasInputError = computed(() => Boolean(columnError.value || typographyErrors.value.fontSize || typographyErrors.value.lineHeight))

/** 数値は十進表記と範囲を検証し、不正な入力は設定値へ送らない。 */
function typographyInputError(field: TypographyField): string {
  const input = typographyInputs.value[field]
  if (/^\d+(?:\.\d+)?$/.test(input) && isValidTypographyNumber(field, Number(input))) return ''
  return field === 'fontSize'
    ? '12～48の整数を入力してください。変更は保存されていません。'
    : '1.0～3.0を0.1刻みで入力してください。変更は保存されていません。'
}

/** 文字サイズ・行間の入力途中の文字列を保持し、エラー表示へ反映する。 */
function onTypographyInput(field: TypographyField, value: string): void {
  typographyInputs.value[field] = value
  typographyDirty[field] = true
}

/** 有効な文字サイズ・行間を即時反映し、共通のUndo・自動保存経路へ送る。 */
function onTypographyValue(field: TypographyField, value: number): void {
  if (!snapshot.value || typographyErrors.value[field] || !isValidTypographyNumber(field, value)) return
  typographyValues.value[field] = value
  typographyDirty[field] = true
  const hasPendingValue = typographyPendingValues[field] !== null
  if (!hasPendingValue && snapshot.value.editor[field] === value) return

  typographyPendingValues[field] = value
  void sendCommand({ type: 'change', editor: { [field]: value } })
}

/** スピン操作やホイール操作の後、確定済み数値へ入力状態をそろえる。 */
function onTypographyInteraction(field: TypographyField, value: number): void {
  if (!snapshot.value || typographyErrors.value[field] || !isValidTypographyNumber(field, value)) return
  typographyValues.value[field] = value
  typographyInputs.value[field] = String(value)
  typographyDirty[field] = false
}

/** フォーカス移動後の有効値を整え、保存待ちの変更を確実に書き出す。 */
function commitTypographyInput(field: TypographyField): void {
  if (!snapshot.value || typographyErrors.value[field]) return
  const value = Number(typographyInputs.value[field])
  if (!isValidTypographyNumber(field, value)) return
  typographyValues.value[field] = value
  typographyInputs.value[field] = String(value)
  typographyDirty[field] = false
  if (typographyPendingValues[field] === null && snapshot.value.editor[field] === value) return
  typographyPendingValues[field] = value
  void sendCommand({ type: 'change', editor: { [field]: value }, flush: true })
}

/** 現在値より古い状態通知で入力欄を巻き戻さないよう、反映待ちの値を記録する。 */
function trackTypographyPendingValue(field: TypographyField, value: number): void {
  if (!snapshot.value) return
  if (typographyPendingValues[field] !== null || snapshot.value.editor[field] !== value) {
    typographyPendingValues[field] = value
  }
}

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

/** 本文設定の部分変更を共通の自動保存経路へ送る。 */
function changeEditor(value: Partial<EditorSettings>): void {
  if (!snapshot.value) return
  void sendCommand({ type: 'change', editor: value })
}

/** 指定桁数の入力途中の文字列を保持し、エラー表示へ反映する。 */
function onColumnsInput(value: string): void {
  columnsInput.value = value
  columnsInputDirty.value = true
}

/** 有効な指定桁数を即時反映し、共通のUndo・自動保存経路へ送る。 */
function onColumnsValue(value: number): void {
  if (!snapshot.value || columnError.value || !Number.isInteger(value) || value < 1 || value > 500) return
  columnsValue.value = value
  columnsInputDirty.value = true
  if (columnsPendingValue === null && snapshot.value.editor.wrapColumns === value) return

  columnsPendingValue = value
  void sendCommand({ type: 'change', editor: { wrapColumns: value } })
}

/** 指定桁数のスピン操作やホイール操作後に、dirty状態を解除する。 */
function onColumnsInteraction(value: number): void {
  if (!snapshot.value || columnError.value || !Number.isInteger(value) || value < 1 || value > 500) return
  columnsValue.value = value
  columnsInput.value = String(value)
  columnsInputDirty.value = false
}

/** フォーカス移動後の有効な桁数を整え、保存待ちの変更を確実に書き出す。 */
function commitColumnsInput(): void {
  if (!snapshot.value || columnError.value) return
  const wrapColumns = Number(columnsInput.value)
  columnsValue.value = wrapColumns
  columnsInput.value = String(wrapColumns)
  columnsInputDirty.value = false
  if (columnsPendingValue === null && snapshot.value.editor.wrapColumns === wrapColumns) return
  columnsPendingValue = wrapColumns
  void sendCommand({ type: 'change', editor: { wrapColumns }, flush: true })
}

/** 表示中の状態通知に先行して入力した指定桁数を、同期完了まで保持する。 */
function trackColumnsPendingValue(value: number): void {
  if (!snapshot.value) return
  if (columnsPendingValue !== null || snapshot.value.editor.wrapColumns !== value) {
    columnsPendingValue = value
  }
}

/** 個別設定を対応する初期値へ戻し、自動保存する。 */
function restoreField(field: keyof EditorSettings): void {
  if (!snapshot.value) return
  if (field === 'wrapColumns') {
    columnsValue.value = defaultEditorSettings.wrapColumns
    columnsInput.value = String(defaultEditorSettings.wrapColumns)
    columnsInputDirty.value = false
    trackColumnsPendingValue(defaultEditorSettings.wrapColumns)
  }
  if (field === 'fontSize' || field === 'lineHeight') {
    typographyValues.value[field] = defaultEditorSettings[field]
    typographyInputs.value[field] = String(defaultEditorSettings[field])
    typographyDirty[field] = false
    trackTypographyPendingValue(field, defaultEditorSettings[field])
  }
  const editor = field === 'fontFamily'
    ? { fontFamily: defaultEditorSettings.fontFamily, fontFallback: defaultEditorSettings.fontFallback }
    : { [field]: defaultEditorSettings[field] }
  void sendCommand({ type: 'change', editor })
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

/** 全設定初期化の確認画面を開く。 */
function restoreAllDefaults(): void {
  allResetDialog.value = true
}

/** 確認後に全設定を初期値へ戻し、1回の更新として即時保存する。 */
function confirmAllDefaults(): void {
  allResetDialog.value = false
  if (!snapshot.value) return
  const toolbar = { ...resetToolbarPreferences(snapshot.value.toolbar), visible: true }
  const barSizes = resetInterfaceBarSizes()
  columnsValue.value = defaultEditorSettings.wrapColumns
  trackColumnsPendingValue(defaultEditorSettings.wrapColumns)
  for (const field of typographyFields) {
    typographyValues.value[field] = defaultEditorSettings[field]
    trackTypographyPendingValue(field, defaultEditorSettings[field])
  }
  snapshot.value = {
    ...snapshot.value,
    editor: { ...defaultEditorSettings },
    toolbar,
    barSizes,
  }
  columnsInput.value = String(defaultEditorSettings.wrapColumns)
  columnsInputDirty.value = false
  for (const field of typographyFields) {
    typographyInputs.value[field] = String(defaultEditorSettings[field])
    typographyDirty[field] = false
  }
  void sendCommand({
    type: 'change',
    editor: { ...defaultEditorSettings },
    toolbar,
    barSizes,
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
  if (columnsPendingValue !== null && columnsPendingValue === nextSnapshot.editor.wrapColumns) {
    columnsPendingValue = null
  }
  if ((!previousSnapshot || editorValueChanged) && !columnsInputDirty.value && columnsPendingValue === null) {
    columnsValue.value = nextSnapshot.editor.wrapColumns
    columnsInput.value = String(nextSnapshot.editor.wrapColumns)
  }
  for (const field of typographyFields) {
    if (typographyPendingValues[field] !== null && typographyPendingValues[field] === nextSnapshot.editor[field]) {
      typographyPendingValues[field] = null
    }
    if ((!previousSnapshot || previousSnapshot.editor[field] !== nextSnapshot.editor[field]) && !typographyDirty[field] && typographyPendingValues[field] === null) {
      typographyValues.value[field] = nextSnapshot.editor[field]
      typographyInputs.value[field] = String(nextSnapshot.editor[field])
    }
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
  if (activeView.value === 'application.storage') return
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
                  :disabled="!snapshot?.history.canUndo || activeView === 'application.storage'"
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
                  :disabled="!snapshot?.history.canRedo || activeView === 'application.storage'"
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
    <VDialog v-model="allResetDialog" max-width="440">
      <VCard title="すべての設定を初期値に戻しますか？">
        <VCardText>本文表示、折り返し、ツールバー、各バーのサイズを初期値へ変更し、自動保存します。データ保存先は変更しません。</VCardText>
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
