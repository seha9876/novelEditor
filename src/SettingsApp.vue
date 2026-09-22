<script setup lang="ts">
// 折り返しとツールバーの現在値を一画面で編集し、確定した変更を自動保存する。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import SettingSubsection from './SettingSubsection.vue'
import { appCommandDefinitions, getToolbarCommandDefinitions, type CommandId } from './appCommands'
import {
  createDefaultToolbarItems,
  type ToolbarItem,
} from './appPreferences'
import {
  defaultEditorSettings,
  type EditorSettings,
  type NarrowWrapBehavior,
  type WrapMode,
} from './editorSettings'
import {
  SETTINGS_COMMAND_EVENT,
  SETTINGS_ERROR_EVENT,
  SETTINGS_STATE_EVENT,
  type SettingsCommand,
  type SettingsPageId,
  type SettingsSnapshot,
} from './settingsSession'

const snapshot = ref<SettingsSnapshot | null>(null)
const columnsInput = ref('80')
const columnsInputDirty = ref(false)
const errorMessage = ref('')
const activePage = ref<SettingsPageId>('editor.wrapping')
const openedGroups = ref(['editor', 'appearance'])
const draggedIndex = ref<number | null>(null)
const toolbarInsertionIndex = ref<number | null>(null)
const toolbarResetDialog = ref(false)
const allResetDialog = ref(false)
const availableCommands = computed(() => getToolbarCommandDefinitions())
const commands = appCommandDefinitions
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
let separatorSequence = 0

/** 設定変更やページ移動をメインウィンドウへ送る。 */
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

/** 折り返し方法の選択を現在値として保存要求へ送る。 */
function setWrapMode(mode: WrapMode): void {
  if (!snapshot.value) return
  void sendCommand({ type: 'change', editor: { wrapMode: mode } })
}

/** 指定桁数が窓より広い場合の表示方法を現在値へ反映する。 */
function setNarrowBehavior(behavior: NarrowWrapBehavior): void {
  if (!snapshot.value) return
  void sendCommand({ type: 'change', editor: { narrowWrapBehavior: behavior } })
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
function changeToolbar(value: { visible?: boolean; items?: ToolbarItem[] }, flush = false): void {
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

/** 利用可能なコマンドを現在のツールバーへ一度だけ追加する。 */
function addCommand(commandId: CommandId): void {
  if (!snapshot.value || snapshot.value.toolbar.items.some((item) => item.type === 'command' && item.commandId === commandId)) return
  changeToolbar({ items: [...snapshot.value.toolbar.items, { type: 'command', commandId }] })
}

/** 複数配置できるセパレーターを末尾へ追加する。 */
function addSeparator(): void {
  if (!snapshot.value) return
  const items = snapshot.value.toolbar.items
  changeToolbar({ items: [...items, { type: 'separator', id: createSeparatorId(items) }] })
}

/** 現在の構成と重複しない識別子を新しいセパレーターへ割り当てる。 */
function createSeparatorId(items: ToolbarItem[]): string {
  let id = ''
  do {
    separatorSequence += 1
    id = `separator-${Date.now()}-${separatorSequence}`
  } while (items.some((item) => item.type === 'separator' && item.id === id))
  return id
}

/** 指定位置のツールバー項目を削除する。 */
function removeToolbarItem(index: number): void {
  if (!snapshot.value) return
  changeToolbar({ items: snapshot.value.toolbar.items.filter((_, itemIndex) => itemIndex !== index) })
}

/** ツールバー項目を上下へ移動する。 */
function moveToolbarItem(index: number, direction: -1 | 1): void {
  if (!snapshot.value) return
  const items = [...snapshot.value.toolbar.items]
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= items.length) return
  ;[items[index], items[targetIndex]] = [items[targetIndex], items[index]]
  changeToolbar({ items })
}

/** ドラッグ開始位置を記録し、挿入位置表示を初期化する。 */
function startDragging(index: number, event: DragEvent): void {
  if (!snapshot.value) return
  draggedIndex.value = index
  toolbarInsertionIndex.value = null
  event.dataTransfer?.setData('text/plain', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

/** 行内のポインター位置から、元の配列における挿入境界を求める。 */
function getToolbarInsertionBoundary(index: number, event: DragEvent): number {
  const row = event.currentTarget as HTMLElement
  const bounds = row.getBoundingClientRect()
  return index + (event.clientY >= bounds.top + bounds.height / 2 ? 1 : 0)
}

/** 並べ替え結果が変わる位置だけ、挿入インジケーターを表示する。 */
function setToolbarInsertionBoundary(boundary: number): void {
  const sourceIndex = draggedIndex.value
  if (sourceIndex === null) return
  const destinationIndex = boundary > sourceIndex ? boundary - 1 : boundary
  toolbarInsertionIndex.value = destinationIndex === sourceIndex ? null : boundary
}

/** ドラッグ中のポインター位置に応じて行の前後へ挿入線を移動する。 */
function onToolbarItemDragOver(index: number, event: DragEvent): void {
  if (draggedIndex.value === null) return
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  setToolbarInsertionBoundary(getToolbarInsertionBoundary(index, event))
}

/** ツールバー項目の末尾に挿入線を表示する。 */
function onToolbarEndDragOver(event: DragEvent): void {
  if (draggedIndex.value === null || !snapshot.value) return
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  setToolbarInsertionBoundary(snapshot.value.toolbar.items.length)
}

/** 空のツールバーをドロップ先として示す。 */
function onToolbarEmptyDragOver(event: DragEvent): void {
  onToolbarEndDragOver(event)
}

/** リストの外へポインターが出たときに挿入線だけを消す。 */
function onToolbarListDragLeave(event: DragEvent): void {
  const list = event.currentTarget as HTMLElement
  const nextTarget = event.relatedTarget
  if (nextTarget instanceof Node && list.contains(nextTarget)) return
  toolbarInsertionIndex.value = null
}

/** ドラッグされた項目を挿入境界へ移動し、下方向の添字ずれを補正する。 */
function dropToolbarItem(event: DragEvent, targetIndex: number | null): void {
  const sourceIndex = draggedIndex.value
  if (!snapshot.value || sourceIndex === null) {
    clearToolbarDragState()
    return
  }

  const boundary = targetIndex === null
    ? snapshot.value.toolbar.items.length
    : getToolbarInsertionBoundary(targetIndex, event)
  const destinationIndex = boundary > sourceIndex ? boundary - 1 : boundary
  if (destinationIndex !== sourceIndex) {
    const items = [...snapshot.value.toolbar.items]
    const [item] = items.splice(sourceIndex, 1)
    items.splice(destinationIndex, 0, item)
    changeToolbar({ items })
  }
  clearToolbarDragState()
}

/** ドラッグ終了時に項目の強調と挿入線を消す。 */
function clearToolbarDragState(): void {
  draggedIndex.value = null
  toolbarInsertionIndex.value = null
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
  activePage.value = nextSnapshot.page
  if (!previousSnapshot || editorValueChanged) {
    columnsInput.value = String(nextSnapshot.editor.wrapColumns)
    columnsInputDirty.value = false
  }
}

// メインウィンドウの状態を受け取れるようにしてから、現在値を要求する。
onMounted(async () => {
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
  unlistenState?.()
  unlistenError?.()
})
</script>

<template>
  <VApp class="settings-shell">
    <VAppBar title="設定" flat>
      <template #append>
        <VChip v-if="snapshot?.saveState === 'pending' || snapshot?.saveState === 'saving'" class="settings-save-state" size="small" variant="tonal" role="status" aria-live="polite">
          <VProgressCircular v-if="snapshot.saveState === 'saving'" class="mr-2" indeterminate size="14" width="2" aria-hidden="true" />
          {{ snapshot.saveState === 'saving' ? '保存中' : '保存待ち' }}
        </VChip>
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
              <VChip v-if="columnError" color="error" size="x-small" variant="tonal" aria-label="指定桁数に入力エラーがあります">入力エラー</VChip>
            </template>
          </VListItem>
        </VListGroup>
        <VListGroup value="appearance">
          <template #activator="{ props }">
            <VListItem v-bind="props" title="外観" prepend-icon="mdi-palette-outline" />
          </template>
          <VListItem :active="activePage === 'appearance.toolbar'" title="ツールバー" @click="selectPage('appearance.toolbar')" />
        </VListGroup>
      </VList>
      <div class="settings-navigation-footer">
        <VBtn block variant="text" prepend-icon="mdi-restore" :disabled="!snapshot" @click="restoreAllDefaults">すべて初期値に戻す</VBtn>
      </div>
    </VNavigationDrawer>
    <VMain class="settings-main">
      <VContainer v-if="snapshot" class="settings-content" fluid>
        <section v-if="activePage === 'editor.wrapping'" aria-labelledby="wrapping-page-title">
          <h1 id="wrapping-page-title" class="settings-page-title">折り返し</h1>
          <VRow>
            <VCol cols="12">
              <VCard class="setting-card">
                <VCardItem>
                  <VCardTitle class="setting-card-title">
                    <span>折り返し方法</span>
                  </VCardTitle>
                  <VCardSubtitle>変更は本文へすぐ反映され、自動保存されます。</VCardSubtitle>
                </VCardItem>
                <VCardText>
                  <VRadioGroup :model-value="snapshot.editor.wrapMode" aria-label="折り返し方法">
                    <VRadio value="window" label="右端で折り返し" @change="setWrapMode('window')" />
                    <VRadio value="columns" label="指定桁数で折り返し" @change="setWrapMode('columns')" />
                    <VRadio value="none" label="折り返さない" @change="setWrapMode('none')" />
                  </VRadioGroup>
                  <div class="setting-actions">
                    <VBtn size="small" variant="outlined" @click="restoreField('wrapMode')">初期値に戻す</VBtn>
                  </div>

                  <VExpandTransition>
                    <div v-if="snapshot.editor.wrapMode === 'columns'" class="setting-children" role="group" aria-labelledby="wrap-children-title">
                      <VSheet class="setting-children-sheet" color="surface-light" rounded="lg" border>
                        <h2 id="wrap-children-title" class="setting-children-title">指定桁数で折り返す場合の設定</h2>
                        <SettingSubsection title="指定桁数">
                          <p class="setting-subsection-description">現在の書体で、おおよその表示幅を指定します。</p>
                          <VTextField
                            :model-value="columnsInput"
                            label="桁数"
                            type="text"
                            inputmode="numeric"
                            min="1"
                            max="500"
                            aria-describedby="columns-help"
                            :error-messages="columnError ? [columnError] : []"
                            @update:model-value="onColumnsInput"
                            @blur="commitColumnsInput"
                            @keydown.enter.prevent="commitColumnsInput"
                          />
                          <p id="columns-help" class="setting-help">1～500の整数で指定します。</p>
                          <template #actions>
                            <VBtn size="small" variant="outlined" @click="restoreField('wrapColumns')">初期値に戻す</VBtn>
                          </template>
                        </SettingSubsection>
                        <VDivider class="setting-children-divider" />
                        <SettingSubsection title="指定桁数が窓より広い場合">
                          <VRadioGroup :model-value="snapshot.editor.narrowWrapBehavior" aria-label="指定桁数が窓より広い場合">
                            <VRadio value="scroll" label="指定桁数を優先して横スクロール" @change="setNarrowBehavior('scroll')" />
                            <VRadio value="fit" label="窓幅に合わせて早めに折り返す" @change="setNarrowBehavior('fit')" />
                          </VRadioGroup>
                          <template #actions>
                            <VBtn size="small" variant="outlined" @click="restoreField('narrowWrapBehavior')">初期値に戻す</VBtn>
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
              </VCardTitle>
              <VCardSubtitle>変更はメイン画面へすぐ反映され、自動保存されます。</VCardSubtitle>
            </VCardItem>
            <VCardText>
              <VSwitch
                :model-value="snapshot.toolbar.visible"
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
                      <template #append><VBtn icon="mdi-plus" size="small" variant="text" :disabled="snapshot.toolbar.items.some((item) => item.type === 'command' && item.commandId === command.id)" :aria-label="`${command.label}を追加`" @click="addCommand(command.id)" /></template>
                    </VListItem>
                  </VList>
                  <VBtn class="mt-2" prepend-icon="mdi-minus" variant="tonal" @click="addSeparator">セパレーターを追加</VBtn>
                </section>

                <section class="toolbar-customizer-column" aria-labelledby="toolbar-current-title">
                  <h2 id="toolbar-current-title" class="toolbar-customizer-heading">現在のツールバー</h2>
                  <p class="toolbar-customizer-help">ドラッグ、または上下ボタンで順序を変更できます。</p>
                  <VList density="compact" class="toolbar-customizer-list" aria-label="現在のツールバー構成" @dragleave="onToolbarListDragLeave">
                    <VListItem
                      v-for="(item, index) in snapshot.toolbar.items"
                      :key="item.type === 'command' ? item.commandId : item.id"
                      class="toolbar-customizer-item"
                      :class="{
                        'toolbar-customizer-item-dragging': draggedIndex === index,
                        'toolbar-customizer-item--drop-before': toolbarInsertionIndex === index,
                      }"
                      draggable="true"
                      @dragstart="startDragging(index, $event)"
                      @dragover.prevent.stop="onToolbarItemDragOver(index, $event)"
                      @drop.prevent.stop="dropToolbarItem($event, index)"
                      @dragend="clearToolbarDragState"
                    >
                      <template #prepend>
                        <VIcon :icon="item.type === 'separator' ? 'mdi-drag-horizontal-variant' : commands.find((command) => command.id === item.commandId)?.icon" aria-hidden="true" />
                      </template>
                      <VListItemTitle v-if="item.type === 'command'">{{ commands.find((command) => command.id === item.commandId)?.label }}</VListItemTitle>
                      <VListItemTitle v-else>セパレーター</VListItemTitle>
                      <template #append>
                        <div class="toolbar-customizer-actions">
                          <VBtn icon="mdi-chevron-up" size="small" variant="text" :disabled="index === 0" :aria-label="`項目 ${index + 1} を上へ`" @click="moveToolbarItem(index, -1)" />
                          <VBtn icon="mdi-chevron-down" size="small" variant="text" :disabled="index === snapshot.toolbar.items.length - 1" :aria-label="`項目 ${index + 1} を下へ`" @click="moveToolbarItem(index, 1)" />
                          <VBtn icon="mdi-close" size="small" variant="text" :aria-label="item.type === 'separator' ? 'セパレーターを削除' : `${commands.find((command) => command.id === item.commandId)?.label}を削除`" @click="removeToolbarItem(index)" />
                        </div>
                      </template>
                    </VListItem>
                    <VListItem
                      v-if="snapshot.toolbar.items.length === 0"
                      title="ツールバーは空です"
                      :class="{ 'toolbar-customizer-item--drop-before': toolbarInsertionIndex === 0 }"
                      @dragover.prevent.stop="onToolbarEmptyDragOver"
                      @drop.prevent.stop="dropToolbarItem($event, null)"
                    />
                    <div
                      v-if="snapshot.toolbar.items.length > 0"
                      class="toolbar-customizer-drop-end"
                      :class="{ 'toolbar-customizer-drop-end--active': toolbarInsertionIndex === snapshot.toolbar.items.length }"
                      aria-hidden="true"
                      @dragover.prevent.stop="onToolbarEndDragOver"
                      @drop.prevent.stop="dropToolbarItem($event, null)"
                    />
                  </VList>
                </section>
              </div>
              <div class="setting-actions toolbar-reset-actions">
                <VBtn size="small" variant="outlined" @click="restoreToolbarDefaults">ツールバーを初期状態に戻す</VBtn>
              </div>
            </VCardText>
          </VCard>
        </section>
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
