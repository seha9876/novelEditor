<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import SettingExpansionSection from './SettingExpansionSection.vue'
import { appCommandDefinitions, getToolbarCommandDefinitions, type CommandId } from './appCommands'
import type { ToolbarItem, ToolbarPreferences } from './appPreferences'
import type { SettingsSectionDefinition, SettingsSectionId } from './settingsDefinitions'

const props = defineProps<{
  toolbar: ToolbarPreferences
  headingLevel: number
  sections: readonly SettingsSectionDefinition[]
  expandedSectionIds: readonly SettingsSectionId[]
  dragResetRevision: number
}>()

const emit = defineEmits<{
  updateToolbar: [toolbar: Partial<ToolbarPreferences> & { items?: ToolbarItem[] }, flush?: boolean]
  resetToolbar: []
  toggleSection: [sectionId: SettingsSectionId, expanded: boolean]
}>()

const availableCommands = getToolbarCommandDefinitions()
const commands = appCommandDefinitions
type ToolbarDragSource =
  | { type: 'current'; index: number }
  | { type: 'available'; commandId: CommandId }

const draggedSource = ref<ToolbarDragSource | null>(null)
const toolbarInsertionIndex = ref<number | null>(null)
const toolbarAnnouncement = ref('')
let separatorSequence = 0

/** 操作結果をスクリーンリーダーへ通知する。 */
function announceToolbarChange(message: string): void {
  toolbarAnnouncement.value = ''
  void nextTick(() => {
    toolbarAnnouncement.value = message
  })
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

/** 指定コマンドがツールバー登録可能な候補として定義されているか調べる。 */
function isAvailableCommand(commandId: CommandId): boolean {
  return availableCommands.some((command) => command.id === commandId)
}

/** 指定コマンドが現在のツールバー構成に含まれているか調べる。 */
function isCommandInToolbar(commandId: CommandId): boolean {
  return props.toolbar.items.some((item) => item.type === 'command' && item.commandId === commandId)
}

/** コマンドIDに対応する表示名を取得する。 */
function getCommandLabel(commandId: CommandId): string {
  return commands.find((command) => command.id === commandId)?.label ?? '機能'
}

/** ツールバー項目の表示名を取得する。 */
function getToolbarItemLabel(item: ToolbarItem): string {
  return item.type === 'separator' ? 'セパレーター' : getCommandLabel(item.commandId)
}

/** 利用可能なコマンドを現在のツールバーへ一度だけ追加する。 */
function addCommand(commandId: CommandId): void {
  if (!isAvailableCommand(commandId) || isCommandInToolbar(commandId)) return
  const items = [...props.toolbar.items, { type: 'command' as const, commandId }]
  emit('updateToolbar', { items })
  announceToolbarChange(`${getCommandLabel(commandId)}をツールバーの${items.length}番目に追加しました。`)
}

/** 複数配置できるセパレーターを末尾へ追加する。 */
function addSeparator(): void {
  const items = props.toolbar.items
  const nextItems = [...items, { type: 'separator' as const, id: createSeparatorId(items) }]
  emit('updateToolbar', { items: nextItems })
  announceToolbarChange(`セパレーターをツールバーの${nextItems.length}番目に追加しました。`)
}

/** 指定位置のツールバー項目を削除する。 */
function removeToolbarItem(index: number): void {
  emit('updateToolbar', { items: props.toolbar.items.filter((_, itemIndex) => itemIndex !== index) })
}

/** ツールバー項目を上下へ移動する。 */
function moveToolbarItem(index: number, direction: -1 | 1): void {
  const items = [...props.toolbar.items]
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= items.length) return
  ;[items[index], items[targetIndex]] = [items[targetIndex], items[index]]
  emit('updateToolbar', { items })
  announceToolbarChange(`${getToolbarItemLabel(items[targetIndex])}を${targetIndex + 1}番目へ移動しました。`)
}

/** ドラッグ元を記録し、移動または追加に応じた操作種別を設定する。 */
function startToolbarDragging(source: ToolbarDragSource, event: DragEvent): void {
  if (source.type === 'available' && (!isAvailableCommand(source.commandId) || isCommandInToolbar(source.commandId))) return
  draggedSource.value = source
  toolbarInsertionIndex.value = null
  event.dataTransfer?.setData('text/plain', JSON.stringify(source))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = source.type === 'available' ? 'copy' : 'move'
}

/** 現在のツールバー項目のドラッグを開始する。 */
function startDraggingToolbarItem(index: number, event: DragEvent): void {
  startToolbarDragging({ type: 'current', index }, event)
}

/** 未配置の候補コマンドのドラッグを開始する。 */
function startDraggingAvailableCommand(commandId: CommandId, event: DragEvent): void {
  startToolbarDragging({ type: 'available', commandId }, event)
}

/** 行内のポインター位置から、元の配列における挿入境界を求める。 */
function getToolbarInsertionBoundary(index: number, event: DragEvent): number {
  const row = event.currentTarget as HTMLElement
  const bounds = row.getBoundingClientRect()
  return index + (event.clientY >= bounds.top + bounds.height / 2 ? 1 : 0)
}

/** 並べ替え結果が変わる位置だけ、挿入インジケーターを表示する。 */
function setToolbarInsertionBoundary(boundary: number): void {
  const source = draggedSource.value
  if (!source) return
  if (source.type === 'available') {
    toolbarInsertionIndex.value = Math.max(0, Math.min(boundary, props.toolbar.items.length))
    return
  }
  const destinationIndex = boundary > source.index ? boundary - 1 : boundary
  toolbarInsertionIndex.value = destinationIndex === source.index ? null : boundary
}

/** ドラッグ元に応じて、現在の項目移動または候補の追加に適した効果を設定する。 */
function setToolbarDropEffect(event: DragEvent): void {
  if (event.dataTransfer && draggedSource.value) {
    event.dataTransfer.dropEffect = draggedSource.value.type === 'available' ? 'copy' : 'move'
  }
}

/** ドラッグ中のポインター位置に応じて行の前後へ挿入線を移動する。 */
function onToolbarItemDragOver(index: number, event: DragEvent): void {
  if (draggedSource.value === null) return
  setToolbarDropEffect(event)
  setToolbarInsertionBoundary(getToolbarInsertionBoundary(index, event))
}

/** ツールバー項目の末尾に挿入線を表示する。 */
function onToolbarEndDragOver(event: DragEvent): void {
  if (draggedSource.value === null) return
  setToolbarDropEffect(event)
  setToolbarInsertionBoundary(props.toolbar.items.length)
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

/** ドラッグ元を共通の挿入境界へ追加または移動し、成功した操作だけを反映する。 */
function dropToolbarItem(event: DragEvent, targetIndex: number | null): void {
  const source = draggedSource.value
  const currentItems = props.toolbar.items
  if (source === null) {
    clearToolbarDragState()
    return
  }

  const boundary = targetIndex === null
    ? currentItems.length
    : getToolbarInsertionBoundary(targetIndex, event)

  if (source.type === 'available') {
    const alreadyPresent = currentItems.some((item) => item.type === 'command' && item.commandId === source.commandId)
    if (isAvailableCommand(source.commandId) && !alreadyPresent) {
      const items = [...currentItems]
      const insertionIndex = Math.max(0, Math.min(boundary, items.length))
      items.splice(insertionIndex, 0, { type: 'command', commandId: source.commandId })
      emit('updateToolbar', { items })
      announceToolbarChange(`${getCommandLabel(source.commandId)}をツールバーの${insertionIndex + 1}番目に追加しました。`)
    }
  } else if (source.index >= 0 && source.index < currentItems.length) {
    const destinationIndex = Math.max(0, Math.min(
      boundary > source.index ? boundary - 1 : boundary,
      currentItems.length - 1,
    ))
    if (destinationIndex !== source.index) {
      const items = [...currentItems]
      const [item] = items.splice(source.index, 1)
      items.splice(destinationIndex, 0, item)
      emit('updateToolbar', { items })
      announceToolbarChange(`${getToolbarItemLabel(item)}を${destinationIndex + 1}番目へ移動しました。`)
    }
  }
  clearToolbarDragState()
}

/** ドラッグ終了時に項目の強調と挿入線を消す。 */
function clearToolbarDragState(): void {
  draggedSource.value = null
  toolbarInsertionIndex.value = null
}

watch(() => props.dragResetRevision, clearToolbarDragState)
watch(
  () => props.expandedSectionIds.includes('appearance.toolbar.configuration'),
  (expanded) => { if (!expanded) clearToolbarDragState() },
)
</script>

<template>
  <SettingExpansionSection
    v-for="section in sections"
    :key="section.id"
    :section="section"
    :heading-level="headingLevel"
    :expanded="expandedSectionIds.includes(section.id)"
    @update-expanded="emit('toggleSection', section.id, $event)"
  >
    <template v-if="section.id === 'appearance.toolbar.configuration'">
      <VSwitch
        :model-value="toolbar.visible"
        label="ツールバーを表示"
        color="primary"
        hide-details
        @update:model-value="emit('updateToolbar', { visible: Boolean($event) })"
      />
      <div class="toolbar-customizer">
        <section class="toolbar-customizer-column" aria-labelledby="toolbar-available-title">
          <component :is="`h${headingLevel + 1}`" id="toolbar-available-title" class="toolbar-customizer-heading">追加できる機能</component>
          <span id="toolbar-available-help" class="toolbar-customizer-sr-only">ドラッグしてツールバーの任意の位置へ追加できます。キーボードではプラスボタンで追加してください。</span>
          <VList density="compact" class="toolbar-customizer-list" aria-label="追加できる機能" aria-describedby="toolbar-available-help">
            <VListItem
              v-for="command in availableCommands"
              :key="command.id"
              :title="command.label"
              :draggable="!isCommandInToolbar(command.id)"
              :aria-disabled="isCommandInToolbar(command.id)"
              :class="{
                'toolbar-customizer-available-item': !isCommandInToolbar(command.id),
                'toolbar-customizer-available-item--disabled': isCommandInToolbar(command.id),
                'toolbar-customizer-available-item--dragging': draggedSource?.type === 'available' && draggedSource.commandId === command.id,
              }"
              @dragstart="startDraggingAvailableCommand(command.id, $event)"
              @dragend="clearToolbarDragState"
            >
              <template #prepend>
                <div class="toolbar-customizer-leading">
                  <VTooltip v-if="!isCommandInToolbar(command.id)" text="ドラッグしてツールバーへ追加" location="top">
                    <template #activator="{ props: tooltipProps }">
                      <span v-bind="tooltipProps" class="toolbar-customizer-drag-handle" role="img" tabindex="0" aria-label="ドラッグしてツールバーへ追加">
                        <VIcon icon="mdi-drag-vertical" aria-hidden="true" />
                      </span>
                    </template>
                  </VTooltip>
                  <span v-else class="toolbar-customizer-drag-handle-placeholder" aria-hidden="true" />
                  <VIcon :icon="command.icon" aria-hidden="true" />
                </div>
              </template>
              <template #append>
                <VBtn icon="mdi-plus" size="small" variant="text" :disabled="isCommandInToolbar(command.id)" :aria-label="`${command.label}を追加`" @click="addCommand(command.id)" />
              </template>
            </VListItem>
          </VList>
          <VBtn class="mt-2" prepend-icon="mdi-minus" variant="tonal" @click="addSeparator">セパレーターを追加</VBtn>
        </section>

        <section class="toolbar-customizer-column" aria-labelledby="toolbar-current-title">
          <component :is="`h${headingLevel + 1}`" id="toolbar-current-title" class="toolbar-customizer-heading">現在のツールバー</component>
          <span id="toolbar-current-help" class="toolbar-customizer-sr-only">ドラッグしてツールバー内の順序を変更できます。キーボードでは上下ボタンで移動してください。</span>
          <VList density="compact" class="toolbar-customizer-list" aria-label="現在のツールバー構成" aria-describedby="toolbar-current-help" @dragleave="onToolbarListDragLeave">
            <VListItem
              v-for="(item, index) in toolbar.items"
              :key="item.type === 'command' ? item.commandId : item.id"
              class="toolbar-customizer-item"
              :class="{
                'toolbar-customizer-item-dragging': draggedSource?.type === 'current' && draggedSource.index === index,
                'toolbar-customizer-item--drop-before': toolbarInsertionIndex === index,
              }"
              draggable="true"
              @dragstart="startDraggingToolbarItem(index, $event)"
              @dragover.prevent.stop="onToolbarItemDragOver(index, $event)"
              @drop.prevent.stop="dropToolbarItem($event, index)"
              @dragend="clearToolbarDragState"
            >
              <template #prepend>
                <div class="toolbar-customizer-leading">
                  <VTooltip text="ドラッグして並べ替え" location="top">
                    <template #activator="{ props: tooltipProps }">
                      <span v-bind="tooltipProps" class="toolbar-customizer-drag-handle" role="img" tabindex="0" aria-label="ドラッグして並べ替え">
                        <VIcon icon="mdi-drag-vertical" aria-hidden="true" />
                      </span>
                    </template>
                  </VTooltip>
                  <VIcon :icon="item.type === 'separator' ? 'mdi-drag-horizontal-variant' : commands.find((command) => command.id === item.commandId)?.icon" aria-hidden="true" />
                </div>
              </template>
              <VListItemTitle v-if="item.type === 'command'">{{ commands.find((command) => command.id === item.commandId)?.label }}</VListItemTitle>
              <VListItemTitle v-else>セパレーター</VListItemTitle>
              <template #append>
                <div class="toolbar-customizer-actions">
                  <VBtn icon="mdi-chevron-up" size="small" variant="text" :disabled="index === 0" :aria-label="`項目 ${index + 1} を上へ`" @click="moveToolbarItem(index, -1)" />
                  <VBtn icon="mdi-chevron-down" size="small" variant="text" :disabled="index === toolbar.items.length - 1" :aria-label="`項目 ${index + 1} を下へ`" @click="moveToolbarItem(index, 1)" />
                  <VBtn icon="mdi-close" size="small" variant="text" :aria-label="item.type === 'separator' ? 'セパレーターを削除' : `${commands.find((command) => command.id === item.commandId)?.label}を削除`" @click="removeToolbarItem(index)" />
                </div>
              </template>
            </VListItem>
            <VListItem
              v-if="toolbar.items.length === 0"
              title="ツールバーは空です"
              :class="{ 'toolbar-customizer-item--drop-before': toolbarInsertionIndex === 0 }"
              @dragover.prevent.stop="onToolbarEmptyDragOver"
              @drop.prevent.stop="dropToolbarItem($event, null)"
            />
            <div
              v-if="toolbar.items.length > 0"
              class="toolbar-customizer-drop-end"
              :class="{ 'toolbar-customizer-drop-end--active': toolbarInsertionIndex === toolbar.items.length }"
              aria-hidden="true"
              @dragover.prevent.stop="onToolbarEndDragOver"
              @drop.prevent.stop="dropToolbarItem($event, null)"
            />
          </VList>
        </section>
      </div>
      <span class="toolbar-customizer-live-region" aria-live="polite" aria-atomic="true">{{ toolbarAnnouncement }}</span>
      <div class="setting-actions toolbar-reset-actions">
        <VBtn size="small" variant="outlined" @click="emit('resetToolbar')">ツールバーを初期状態に戻す</VBtn>
      </div>
    </template>
  </SettingExpansionSection>
</template>
