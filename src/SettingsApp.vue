<script setup lang="ts">
// 折り返しとツールバーの設定を一画面にまとめ、変更はメイン画面で試用・保存する。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import SettingSubsection from './SettingSubsection.vue'
import { appCommandDefinitions, getToolbarCommandDefinitions, type CommandId } from './appCommands'
import {
  createDefaultToolbarItems,
  type ToolbarItem,
} from './appPreferences'
import {
  defaultEditorSettings,
  getChangedEditorSettingKeys,
  type EditorSettingKey,
  type EditorSettings,
  type NarrowWrapBehavior,
  type WrapMode,
} from './editorSettings'
import {
  SETTINGS_COMMAND_EVENT,
  SETTINGS_ERROR_EVENT,
  SETTINGS_SAVED_EVENT,
  SETTINGS_STATE_EVENT,
  type SettingsCommand,
  type SettingsPageId,
  type SettingsSnapshot,
} from './settingsSession'

const settingsWindow = getCurrentWindow()
const snapshot = ref<SettingsSnapshot | null>(null)
const columnsInput = ref('80')
const errorMessage = ref('')
const saving = ref(false)
const activePage = ref<SettingsPageId>('editor.wrapping')
const openedGroups = ref(['editor', 'appearance'])
const draggedIndex = ref<number | null>(null)
const settingKeyGroups = {
  wrapSettings: ['wrapMode', 'wrapColumns', 'narrowWrapBehavior'],
  wrapColumns: ['wrapColumns'],
  narrowWrapBehavior: ['narrowWrapBehavior'],
} satisfies Record<string, readonly EditorSettingKey[]>
const availableCommands = computed(() => getToolbarCommandDefinitions())
const commands = appCommandDefinitions
const changedSettingKeys = computed<Set<EditorSettingKey>>(() => {
  if (!snapshot.value) return new Set<EditorSettingKey>()
  const changedKeys = getChangedEditorSettingKeys(snapshot.value.saved, snapshot.value.draft)
  if (columnsInput.value !== String(snapshot.value.saved.wrapColumns)) changedKeys.add('wrapColumns')
  return changedKeys
})
const toolbarModified = computed(() => {
  if (!snapshot.value) return false
  return snapshot.value.savedToolbar.visible !== snapshot.value.draftToolbar.visible ||
    JSON.stringify(snapshot.value.savedToolbar.items) !== JSON.stringify(snapshot.value.draftToolbar.items)
})
const modified = computed(() => changedSettingKeys.value.size > 0 || toolbarModified.value)
const columnError = computed(() => {
  const columns = Number(columnsInput.value)
  return /^[1-9]\d*$/.test(columnsInput.value) && columns <= 500 ? '' : '桁数は1～500の整数で入力してください。'
})
const columnsInputMatchesDraft = computed(() => snapshot.value !== null &&
  !columnError.value && Number(columnsInput.value) === snapshot.value.draft.wrapColumns)
const wrapPageModified = computed(() => hasUnsavedChanges(settingKeyGroups.wrapSettings))
const canSave = computed(() => !!snapshot.value && !columnError.value && columnsInputMatchesDraft.value && !saving.value)
let closingAfterSave = false
let unlistenState: (() => void) | undefined
let unlistenSaved: (() => void) | undefined
let unlistenError: (() => void) | undefined
let unlistenClose: (() => void) | undefined

/** 変更要求をメインウィンドウへ送り、共通のプレビュー状態を更新する。 */
async function sendCommand(command: SettingsCommand): Promise<void> {
  errorMessage.value = ''
  try {
    await emitTo('main', SETTINGS_COMMAND_EVENT, command)
  } catch (error) {
    errorMessage.value = String(error)
  }
}

/** 指定ページへ移動し、メイン画面にも選択ページを共有する。 */
function selectPage(page: SettingsPageId): void {
  activePage.value = page
  void sendCommand({ type: 'navigate', page })
}

/** 折り返し方法の選択を試用値へ反映する。 */
function setWrapMode(mode: WrapMode): void {
  if (!snapshot.value) return
  void sendCommand({ type: 'change-editor', value: { wrapMode: mode } })
}

/** 指定桁数が窓より広い場合の表示方法を試用値へ反映する。 */
function setNarrowBehavior(behavior: NarrowWrapBehavior): void {
  if (!snapshot.value) return
  void sendCommand({ type: 'change-editor', value: { narrowWrapBehavior: behavior } })
}

/** 指定された設定キーのいずれかが未保存状態かを判定する。 */
function hasUnsavedChanges(keys: readonly EditorSettingKey[]): boolean {
  return keys.some((key) => changedSettingKeys.value.has(key))
}

/** 有効な桁数だけを試用値へ反映し、入力途中の値は画面に保持する。 */
function onColumnsInput(value: string | number | null): void {
  columnsInput.value = value === null ? '' : String(value)
  if (!snapshot.value || columnError.value) return
  void sendCommand({ type: 'change-editor', value: { wrapColumns: Number(columnsInput.value) } })
}

/** ドラフトの折り返し設定を保存値または初期値へ戻す。 */
function restoreField(field: keyof EditorSettings, source: 'saved' | 'default'): void {
  if (!snapshot.value) return
  const original = source === 'saved' ? snapshot.value.saved : defaultEditorSettings
  if (field === 'wrapColumns') columnsInput.value = String(original.wrapColumns)
  void sendCommand({ type: 'change-editor', value: { [field]: original[field] } })
}

/** 入力欄の不正値も含め、折り返し設定全体を初期値へ戻す。 */
function restoreEditorDefaults(): void {
  columnsInput.value = String(defaultEditorSettings.wrapColumns)
  void sendCommand({ type: 'change-editor', value: { ...defaultEditorSettings } })
}

/** ツールバーのドラフトだけを更新し、メイン画面へ即時プレビューする。 */
function changeToolbar(value: { visible?: boolean; items?: ToolbarItem[] }): void {
  if (!snapshot.value || saving.value) return
  snapshot.value = {
    ...snapshot.value,
    draftToolbar: {
      ...snapshot.value.draftToolbar,
      ...value,
      items: value.items ? value.items.map((item) => ({ ...item })) : snapshot.value.draftToolbar.items,
    },
  }
  void sendCommand({ type: 'change-toolbar', value })
}

/** 利用可能なコマンドを現在のツールバーへ一度だけ追加する。 */
function addCommand(commandId: CommandId): void {
  if (!snapshot.value || snapshot.value.draftToolbar.items.some((item) => item.type === 'command' && item.commandId === commandId)) return
  changeToolbar({ items: [...snapshot.value.draftToolbar.items, { type: 'command', commandId }] })
}

/** 複数配置できるセパレーターを末尾へ追加する。 */
function addSeparator(): void {
  if (!snapshot.value) return
  const items = snapshot.value.draftToolbar.items
  changeToolbar({ items: [...items, { type: 'separator', id: `separator-${Date.now()}` }] })
}

/** 指定位置のツールバー項目を削除する。 */
function removeToolbarItem(index: number): void {
  if (!snapshot.value) return
  changeToolbar({ items: snapshot.value.draftToolbar.items.filter((_, itemIndex) => itemIndex !== index) })
}

/** ツールバー項目を上下へ移動する。 */
function moveToolbarItem(index: number, direction: -1 | 1): void {
  if (!snapshot.value) return
  const items = [...snapshot.value.draftToolbar.items]
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= items.length) return
  ;[items[index], items[targetIndex]] = [items[targetIndex], items[index]]
  changeToolbar({ items })
}

/** ドラッグ開始位置を記録する。 */
function startDragging(index: number, event: DragEvent): void {
  if (!snapshot.value || saving.value) return
  draggedIndex.value = index
  event.dataTransfer?.setData('text/plain', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

/** ドラッグされた項目を指定位置へ移動する。 */
function dropToolbarItem(targetIndex: number): void {
  const sourceIndex = draggedIndex.value
  if (!snapshot.value || sourceIndex === null || sourceIndex === targetIndex) return
  const items = [...snapshot.value.draftToolbar.items]
  const [item] = items.splice(sourceIndex, 1)
  items.splice(targetIndex, 0, item)
  changeToolbar({ items })
  draggedIndex.value = null
}

/** ツールバー構成を初期状態へ戻す。表示状態はそのまま保持する。 */
function restoreToolbarDefaults(): void {
  changeToolbar({ items: createDefaultToolbarItems() })
}

/** エディターとツールバーのドラフトを初期状態へ戻す。 */
function restoreAllDefaults(): void {
  restoreEditorDefaults()
  changeToolbar({ visible: true, items: createDefaultToolbarItems() })
}

/** 新しいスナップショットを受け取り、編集中の不正な桁数文字列を保つ。 */
function receiveSettingsSnapshot(nextSnapshot: SettingsSnapshot): void {
  const previousSnapshot = snapshot.value
  const preserveInvalidColumnsInput = previousSnapshot !== null &&
    !!columnError.value &&
    nextSnapshot.draft.wrapColumns === previousSnapshot.draft.wrapColumns

  snapshot.value = nextSnapshot
  activePage.value = nextSnapshot.page
  if (!preserveInvalidColumnsInput) columnsInput.value = String(nextSnapshot.draft.wrapColumns)
}

/** ドラフト全体を保存し、保存完了の通知を待つ。 */
async function saveSettings(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  await sendCommand({ type: 'save' })
}

/** キャンセル要求を通常のウィンドウ終了処理へ渡す。 */
async function cancelSettings(): Promise<void> {
  await settingsWindow.close()
}

/** Esc をキャンセルとして扱う。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    void cancelSettings()
  }
}

// メインウィンドウの状態を受け取れるようにしてから、現在値を要求する。
onMounted(async () => {
  unlistenState = await listen<SettingsSnapshot>(SETTINGS_STATE_EVENT, (event) => {
    receiveSettingsSnapshot(event.payload)
  })
  unlistenSaved = await listen(SETTINGS_SAVED_EVENT, () => {
    closingAfterSave = true
    void settingsWindow.close()
  })
  unlistenError = await listen<string>(SETTINGS_ERROR_EVENT, (event) => {
    errorMessage.value = event.payload
    saving.value = false
  })
  unlistenClose = await settingsWindow.onCloseRequested(async (event) => {
    if (closingAfterSave) return
    event.preventDefault()
    if (saving.value) return
    try {
      await emitTo('main', SETTINGS_COMMAND_EVENT, { type: 'cancel' } satisfies SettingsCommand)
      await settingsWindow.destroy()
    } catch (error) {
      errorMessage.value = String(error)
    }
  })
  window.addEventListener('keydown', onKeydown)
  await sendCommand({ type: 'ready' })
})

// 設定ウィンドウを破棄する際にイベント購読を解除する。
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unlistenState?.()
  unlistenSaved?.()
  unlistenError?.()
  unlistenClose?.()
})
</script>

<template>
  <VApp class="settings-shell">
    <VAppBar title="設定" flat>
      <template #append>
        <VChip v-if="modified" class="settings-pending" color="warning" size="small" variant="tonal" role="status" aria-live="polite" aria-atomic="true">未保存の変更があります</VChip>
      </template>
    </VAppBar>
    <VNavigationDrawer permanent width="236" class="settings-navigation">
      <VList v-model:opened="openedGroups" nav density="compact" aria-label="設定項目">
        <VListGroup value="editor">
          <template #activator="{ props }">
            <VListItem v-bind="props" title="エディター" prepend-icon="mdi-text-box-edit-outline" />
          </template>
          <VListItem :active="activePage === 'editor.wrapping'" title="折り返し" @click="selectPage('editor.wrapping')">
            <template #append>
              <VIcon v-if="columnError" icon="mdi-alert-circle-outline" color="error" size="small" aria-label="入力エラー" />
              <VChip v-else-if="wrapPageModified" size="x-small" variant="tonal">未保存</VChip>
            </template>
          </VListItem>
        </VListGroup>
        <VListGroup value="appearance">
          <template #activator="{ props }">
            <VListItem v-bind="props" title="外観" prepend-icon="mdi-palette-outline" />
          </template>
          <VListItem :active="activePage === 'appearance.toolbar'" title="ツールバー" @click="selectPage('appearance.toolbar')">
            <template #append><VChip v-if="toolbarModified" size="x-small" variant="tonal">未保存</VChip></template>
          </VListItem>
        </VListGroup>
      </VList>
    </VNavigationDrawer>
    <VMain class="settings-main">
      <VContainer v-if="snapshot" class="settings-content" fluid :inert="saving">
        <section v-if="activePage === 'editor.wrapping'" aria-labelledby="wrapping-page-title">
          <h1 id="wrapping-page-title" class="settings-page-title">折り返し</h1>
          <VRow>
            <VCol cols="12">
              <VCard class="setting-card">
                <VCardItem>
                  <VCardTitle class="setting-card-title">
                    <span>折り返し方法</span>
                    <VChip v-if="hasUnsavedChanges(settingKeyGroups.wrapSettings)" class="setting-pending" size="x-small" variant="tonal" role="status" aria-live="polite" aria-atomic="true">未保存</VChip>
                  </VCardTitle>
                  <VCardSubtitle>変更は本文へすぐ反映されます。保存するまで再起動後には残りません。</VCardSubtitle>
                </VCardItem>
                <VCardText>
                  <VRadioGroup :model-value="snapshot.draft.wrapMode" aria-label="折り返し方法">
                    <VRadio value="window" label="右端で折り返し" @change="setWrapMode('window')" />
                    <VRadio value="columns" label="指定桁数で折り返し" @change="setWrapMode('columns')" />
                    <VRadio value="none" label="折り返さない" @change="setWrapMode('none')" />
                  </VRadioGroup>
                  <div class="setting-actions">
                    <VBtn size="small" variant="outlined" @click="restoreField('wrapMode', 'saved')">保存値に戻す</VBtn>
                    <VBtn size="small" variant="outlined" @click="restoreField('wrapMode', 'default')">初期値に戻す</VBtn>
                  </div>

                  <VExpandTransition>
                    <div v-if="snapshot.draft.wrapMode === 'columns'" class="setting-children" role="group" aria-labelledby="wrap-children-title">
                      <VSheet class="setting-children-sheet" color="surface-light" rounded="lg" border>
                        <h2 id="wrap-children-title" class="setting-children-title">指定桁数で折り返す場合の設定</h2>
                        <SettingSubsection title="指定桁数" :modified="hasUnsavedChanges(settingKeyGroups.wrapColumns)">
                          <p class="setting-subsection-description">現在の書体で、おおよその表示幅を指定します。</p>
                          <VTextField
                            :model-value="columnsInput"
                            label="桁数"
                            type="number"
                            min="1"
                            max="500"
                            step="1"
                            aria-describedby="columns-help"
                            :error-messages="columnError ? [columnError] : []"
                            @update:model-value="onColumnsInput"
                          />
                          <p id="columns-help" class="setting-help">1～500の整数で指定します。</p>
                          <template #actions>
                            <VBtn size="small" variant="outlined" @click="restoreField('wrapColumns', 'saved')">保存値に戻す</VBtn>
                            <VBtn size="small" variant="outlined" @click="restoreField('wrapColumns', 'default')">初期値に戻す</VBtn>
                          </template>
                        </SettingSubsection>
                        <VDivider class="setting-children-divider" />
                        <SettingSubsection title="指定桁数が窓より広い場合" :modified="hasUnsavedChanges(settingKeyGroups.narrowWrapBehavior)">
                          <VRadioGroup :model-value="snapshot.draft.narrowWrapBehavior" aria-label="指定桁数が窓より広い場合">
                            <VRadio value="scroll" label="指定桁数を優先して横スクロール" @change="setNarrowBehavior('scroll')" />
                            <VRadio value="fit" label="窓幅に合わせて早めに折り返す" @change="setNarrowBehavior('fit')" />
                          </VRadioGroup>
                          <template #actions>
                            <VBtn size="small" variant="outlined" @click="restoreField('narrowWrapBehavior', 'saved')">保存値に戻す</VBtn>
                            <VBtn size="small" variant="outlined" @click="restoreField('narrowWrapBehavior', 'default')">初期値に戻す</VBtn>
                          </template>
                        </SettingSubsection>
                      </VSheet>
                    </div>
                  </VExpandTransition>
                </VCardText>
              </VCard>
            </VCol>
          </VRow>
        </section>

        <section v-else aria-labelledby="toolbar-page-title">
          <h1 id="toolbar-page-title" class="settings-page-title">ツールバー</h1>
          <VCard class="setting-card">
            <VCardItem>
              <VCardTitle class="setting-card-title">
                <span>ツールバーの構成</span>
                <VChip v-if="toolbarModified" class="setting-pending" size="x-small" variant="tonal" role="status" aria-live="polite" aria-atomic="true">未保存</VChip>
              </VCardTitle>
              <VCardSubtitle>変更はメイン画面へすぐ反映されます。保存するまで再起動後には残りません。</VCardSubtitle>
            </VCardItem>
            <VCardText>
              <VSwitch
                :model-value="snapshot.draftToolbar.visible"
                label="ツールバーを表示"
                color="primary"
                hide-details
                @update:model-value="changeToolbar({ visible: Boolean($event) })"
              />
              <div class="toolbar-customizer">
                <section class="toolbar-customizer-column" aria-labelledby="toolbar-available-title">
                  <h2 id="toolbar-available-title" class="toolbar-customizer-heading">追加できる機能</h2>
                  <VList density="compact" class="toolbar-customizer-list">
                    <VListItem v-for="command in availableCommands" :key="command.id" :title="command.label">
                      <template #prepend><VIcon :icon="command.icon" aria-hidden="true" /></template>
                      <template #append><VBtn icon="mdi-plus" size="small" variant="text" :disabled="saving || snapshot.draftToolbar.items.some((item) => item.type === 'command' && item.commandId === command.id)" :aria-label="`${command.label}を追加`" @click="addCommand(command.id)" /></template>
                    </VListItem>
                  </VList>
                  <VBtn class="mt-2" prepend-icon="mdi-minus" variant="tonal" :disabled="saving" @click="addSeparator">セパレーターを追加</VBtn>
                </section>

                <section class="toolbar-customizer-column" aria-labelledby="toolbar-current-title">
                  <h2 id="toolbar-current-title" class="toolbar-customizer-heading">現在のツールバー</h2>
                  <p class="toolbar-customizer-help">ドラッグ、または上下ボタンで順序を変更できます。</p>
                  <VList density="compact" class="toolbar-customizer-list" aria-label="現在のツールバー構成">
                    <VListItem
                      v-for="(item, index) in snapshot.draftToolbar.items"
                      :key="item.type === 'command' ? item.commandId : item.id"
                      class="toolbar-customizer-item"
                      :class="{ 'toolbar-customizer-item-dragging': draggedIndex === index }"
                      :draggable="!saving"
                      @dragstart="startDragging(index, $event)"
                      @dragover.prevent
                      @drop.prevent="dropToolbarItem(index)"
                      @dragend="draggedIndex = null"
                    >
                      <template #prepend>
                        <VIcon :icon="item.type === 'separator' ? 'mdi-drag-horizontal-variant' : commands.find((command) => command.id === item.commandId)?.icon" aria-hidden="true" />
                      </template>
                      <VListItemTitle v-if="item.type === 'command'">{{ commands.find((command) => command.id === item.commandId)?.label }}</VListItemTitle>
                      <VListItemTitle v-else>セパレーター</VListItemTitle>
                      <template #append>
                        <div class="toolbar-customizer-actions">
                          <VBtn icon="mdi-chevron-up" size="small" variant="text" :disabled="saving || index === 0" :aria-label="`項目 ${index + 1} を上へ`" @click="moveToolbarItem(index, -1)" />
                          <VBtn icon="mdi-chevron-down" size="small" variant="text" :disabled="saving || index === snapshot.draftToolbar.items.length - 1" :aria-label="`項目 ${index + 1} を下へ`" @click="moveToolbarItem(index, 1)" />
                          <VBtn icon="mdi-close" size="small" variant="text" :disabled="saving" :aria-label="item.type === 'separator' ? 'セパレーターを削除' : `${commands.find((command) => command.id === item.commandId)?.label}を削除`" @click="removeToolbarItem(index)" />
                        </div>
                      </template>
                    </VListItem>
                    <VListItem v-if="snapshot.draftToolbar.items.length === 0" title="ツールバーは空です" />
                  </VList>
                </section>
              </div>
              <div class="setting-actions toolbar-reset-actions">
                <VBtn size="small" variant="outlined" :disabled="saving" @click="restoreToolbarDefaults">ツールバーを初期状態に戻す</VBtn>
              </div>
            </VCardText>
          </VCard>
        </section>
      </VContainer>
      <VContainer v-else>
        <VAlert type="info" variant="tonal">設定を読み込んでいます。</VAlert>
      </VContainer>
    </VMain>
    <VFooter app class="settings-footer">
      <VAlert v-if="errorMessage" class="settings-error" type="error" variant="tonal" density="compact" role="alert">{{ errorMessage }}</VAlert>
      <VAlert v-if="columnError" class="settings-error" type="error" variant="tonal" density="compact" role="alert">折り返し設定に入力エラーがあります。折り返しページを確認してください。</VAlert>
      <VSpacer />
      <VBtn variant="text" :disabled="!snapshot || saving" @click="restoreAllDefaults">すべて初期値に戻す</VBtn>
      <VBtn variant="text" :disabled="saving" @click="cancelSettings">キャンセル</VBtn>
      <VBtn color="primary" :disabled="!canSave" :loading="saving" @click="saveSettings">保存</VBtn>
    </VFooter>
  </VApp>
</template>
