<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import SettingExpansionSection from './SettingExpansionSection.vue'
import { statusBarItemDefinitions, type StatusBarItemId, type StatusBarPreferences } from './appPreferenceSchema'
import {
  getStatusBarSettingsItems,
  insertStatusBarItemAtSettingsIndex,
  moveStatusBarItemAtSettingsIndex,
  removeStatusBarItemAtSettingsIndex,
  reorderStatusBarItemsAtSettingsIndex,
} from './statusBarOrdering'
import type { SettingsSectionDefinition, SettingsSectionId } from './settingsDefinitions'

const props = defineProps<{
  statusBar: StatusBarPreferences
  headingLevel: number
  sections: readonly SettingsSectionDefinition[]
  expandedSectionIds: readonly SettingsSectionId[]
  dragResetRevision: number
}>()

const emit = defineEmits<{
  updateStatusBar: [statusBar: Partial<StatusBarPreferences> & { items?: StatusBarItemId[] }, flush?: boolean]
  resetStatusBar: []
  toggleSection: [sectionId: SettingsSectionId, expanded: boolean]
}>()

type StatusBarDragSource =
  | { type: 'current'; settingsIndex: number }
  | { type: 'available'; itemId: StatusBarItemId }

const draggedSource = ref<StatusBarDragSource | null>(null)
const insertionIndex = ref<number | null>(null)
const announcement = ref('')
const displayedItems = computed(() => getStatusBarSettingsItems(props.statusBar.items))

/** 操作結果をスクリーンリーダーへ通知する。 */
function announceChange(message: string): void {
  announcement.value = ''
  void nextTick(() => {
    announcement.value = message
  })
}

/** 表示項目の定義から表示名を取得する。 */
function getItemLabel(itemId: StatusBarItemId): string {
  return statusBarItemDefinitions.find((item) => item.id === itemId)?.label ?? '表示項目'
}

/** 指定項目がステータスバーの候補として定義されているか調べる。 */
function isAvailableItem(itemId: StatusBarItemId): boolean {
  return statusBarItemDefinitions.some((item) => item.id === itemId)
}

/** 指定項目が現在のステータスバー構成に含まれているか調べる。 */
function isItemInStatusBar(itemId: StatusBarItemId): boolean {
  return props.statusBar.items.includes(itemId)
}

/** 利用可能な表示項目を保存配列の末尾（実表示の右端）へ一度だけ追加する。 */
function addItem(itemId: StatusBarItemId): void {
  if (!isAvailableItem(itemId) || isItemInStatusBar(itemId)) return
  const items = [...props.statusBar.items, itemId]
  emit('updateStatusBar', { items })
  announceChange(`${getItemLabel(itemId)}をステータスバーの右端（一覧の1番上）に追加しました。`)
}

/** 指定位置のステータスバー項目を削除する。 */
function removeItem(settingsIndex: number): void {
  emit('updateStatusBar', { items: removeStatusBarItemAtSettingsIndex(props.statusBar.items, settingsIndex) })
}

/** ステータスバー項目を上下へ移動する。 */
function moveItem(settingsIndex: number, direction: -1 | 1): void {
  const targetIndex = settingsIndex + direction
  if (targetIndex < 0 || targetIndex >= displayedItems.value.length) return
  const itemId = displayedItems.value[settingsIndex]
  const items = moveStatusBarItemAtSettingsIndex(props.statusBar.items, settingsIndex, direction)
  emit('updateStatusBar', { items })
  announceChange(`${getItemLabel(itemId)}を一覧の${targetIndex + 1}番目へ移動しました。`)
}

/** ドラッグ元を記録し、移動または追加に応じた操作種別を設定する。 */
function startDragging(source: StatusBarDragSource, event: DragEvent): void {
  if (source.type === 'available' && (!isAvailableItem(source.itemId) || isItemInStatusBar(source.itemId))) return
  draggedSource.value = source
  insertionIndex.value = null
  event.dataTransfer?.setData('text/plain', JSON.stringify(source))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = source.type === 'available' ? 'copy' : 'move'
}

/** 現在のステータスバー項目のドラッグを開始する。 */
function startDraggingCurrent(settingsIndex: number, event: DragEvent): void {
  startDragging({ type: 'current', settingsIndex }, event)
}

/** 未配置の候補項目のドラッグを開始する。 */
function startDraggingAvailable(itemId: StatusBarItemId, event: DragEvent): void {
  startDragging({ type: 'available', itemId }, event)
}

/** 行内のポインター位置から、設定画面の配列における挿入境界を求める。 */
function getInsertionBoundary(index: number, event: DragEvent): number {
  const row = event.currentTarget as HTMLElement
  const bounds = row.getBoundingClientRect()
  return index + (event.clientY >= bounds.top + bounds.height / 2 ? 1 : 0)
}

/** ドラッグ中のポインター位置に応じて挿入線を移動する。 */
function setInsertionBoundary(boundary: number): void {
  const source = draggedSource.value
  if (!source) return
  if (source.type === 'available') {
    insertionIndex.value = Math.max(0, Math.min(boundary, displayedItems.value.length))
    return
  }
  const destinationIndex = boundary > source.settingsIndex ? boundary - 1 : boundary
  insertionIndex.value = destinationIndex === source.settingsIndex ? null : boundary
}

/** ドラッグ中の項目に応じてドロップ効果を設定する。 */
function setDropEffect(event: DragEvent): void {
  if (event.dataTransfer && draggedSource.value) {
    event.dataTransfer.dropEffect = draggedSource.value.type === 'available' ? 'copy' : 'move'
  }
}

/** 行内のポインター位置へ挿入線を表示する。 */
function onItemDragOver(index: number, event: DragEvent): void {
  if (!draggedSource.value) return
  setDropEffect(event)
  setInsertionBoundary(getInsertionBoundary(index, event))
}

/** 項目リスト末尾へ挿入線を表示する。 */
function onEndDragOver(event: DragEvent): void {
  if (!draggedSource.value) return
  setDropEffect(event)
  setInsertionBoundary(displayedItems.value.length)
}

/** リストの外へポインターが出たときに挿入線だけを消す。 */
function onListDragLeave(event: DragEvent): void {
  const list = event.currentTarget as HTMLElement
  const nextTarget = event.relatedTarget
  if (nextTarget instanceof Node && list.contains(nextTarget)) return
  insertionIndex.value = null
}

/** ドラッグ元を共通の挿入境界へ追加または移動する。 */
function dropItem(event: DragEvent, targetIndex: number | null): void {
  const source = draggedSource.value
  const currentItems = props.statusBar.items
  if (!source) {
    clearDragState()
    return
  }

  const boundary = targetIndex === null ? displayedItems.value.length : getInsertionBoundary(targetIndex, event)
  if (source.type === 'available') {
    const alreadyPresent = currentItems.includes(source.itemId)
    if (isAvailableItem(source.itemId) && !alreadyPresent) {
      const insertionPosition = Math.max(0, Math.min(boundary, displayedItems.value.length))
      const items = insertStatusBarItemAtSettingsIndex(currentItems, source.itemId, insertionPosition)
      emit('updateStatusBar', { items })
      announceChange(`${getItemLabel(source.itemId)}を一覧の${insertionPosition + 1}番目に追加しました。`)
    }
  } else if (source.settingsIndex >= 0 && source.settingsIndex < displayedItems.value.length) {
    const destinationIndex = Math.max(0, Math.min(
      boundary > source.settingsIndex ? boundary - 1 : boundary,
      displayedItems.value.length - 1,
    ))
    if (destinationIndex !== source.settingsIndex) {
      const itemId = displayedItems.value[source.settingsIndex]
      const items = reorderStatusBarItemsAtSettingsIndex(currentItems, source.settingsIndex, destinationIndex)
      emit('updateStatusBar', { items })
      announceChange(`${getItemLabel(itemId)}を一覧の${destinationIndex + 1}番目へ移動しました。`)
    }
  }
  clearDragState()
}

/** ドラッグ終了時に項目の強調と挿入線を消す。 */
function clearDragState(): void {
  draggedSource.value = null
  insertionIndex.value = null
}

watch(() => props.dragResetRevision, clearDragState)
watch(
  () => props.expandedSectionIds.includes('appearance.statusBar.configuration'),
  (expanded) => { if (!expanded) clearDragState() },
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
    <template v-if="section.id === 'appearance.statusBar.configuration'">
      <div class="toolbar-customizer">
        <section class="toolbar-customizer-column" aria-labelledby="status-bar-available-title">
          <component :is="`h${headingLevel + 1}`" id="status-bar-available-title" class="toolbar-customizer-heading">追加できる項目</component>
          <span id="status-bar-available-help" class="toolbar-customizer-sr-only">ドラッグしてステータスバーの任意の位置へ追加できます。キーボードではプラスボタンで追加してください。</span>
          <VList density="compact" class="toolbar-customizer-list" aria-label="追加できるステータスバー項目" aria-describedby="status-bar-available-help">
            <VListItem
              v-for="item in statusBarItemDefinitions"
              :key="item.id"
              :title="item.label"
              :draggable="!isItemInStatusBar(item.id)"
              :aria-disabled="isItemInStatusBar(item.id)"
              :class="{
                'toolbar-customizer-available-item': !isItemInStatusBar(item.id),
                'toolbar-customizer-available-item--disabled': isItemInStatusBar(item.id),
                'toolbar-customizer-available-item--dragging': draggedSource?.type === 'available' && draggedSource.itemId === item.id,
              }"
              @dragstart="startDraggingAvailable(item.id, $event)"
              @dragend="clearDragState"
            >
              <template #prepend>
                <div class="toolbar-customizer-leading">
                  <VTooltip v-if="!isItemInStatusBar(item.id)" text="ドラッグしてステータスバーへ追加" location="top">
                    <template #activator="{ props: tooltipProps }">
                      <span v-bind="tooltipProps" class="toolbar-customizer-drag-handle" role="img" tabindex="0" aria-label="ドラッグしてステータスバーへ追加">
                        <VIcon icon="mdi-drag-vertical" aria-hidden="true" />
                      </span>
                    </template>
                  </VTooltip>
                  <span v-else class="toolbar-customizer-drag-handle-placeholder" aria-hidden="true" />
                  <VIcon :icon="item.icon" aria-hidden="true" />
                </div>
              </template>
              <template #append>
                <VBtn icon="mdi-plus" size="small" variant="text" :disabled="isItemInStatusBar(item.id)" :aria-label="`${item.label}を追加`" @click="addItem(item.id)" />
              </template>
            </VListItem>
          </VList>
        </section>

        <section class="toolbar-customizer-column" aria-labelledby="status-bar-current-title">
          <component :is="`h${headingLevel + 1}`" id="status-bar-current-title" class="toolbar-customizer-heading">現在のステータスバー</component>
          <p class="setting-help">一覧の上から順に、ステータスバーでは右端から左へ表示します。</p>
          <span id="status-bar-current-help" class="toolbar-customizer-sr-only">一覧の上から右端、下へ行くほど左側に表示されます。ドラッグしてステータスバー内の順序を変更できます。キーボードでは上下ボタンで移動してください。</span>
          <VList density="compact" class="toolbar-customizer-list" aria-label="現在のステータスバー構成" aria-describedby="status-bar-current-help" @dragleave="onListDragLeave">
            <VListItem
              v-for="(itemId, index) in displayedItems"
              :key="itemId"
              class="toolbar-customizer-item"
              :class="{
                'toolbar-customizer-item-dragging': draggedSource?.type === 'current' && draggedSource.settingsIndex === index,
                'toolbar-customizer-item--drop-before': insertionIndex === index,
              }"
              draggable="true"
              @dragstart="startDraggingCurrent(index, $event)"
              @dragover.prevent.stop="onItemDragOver(index, $event)"
              @drop.prevent.stop="dropItem($event, index)"
              @dragend="clearDragState"
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
                  <VIcon :icon="statusBarItemDefinitions.find((item) => item.id === itemId)?.icon" aria-hidden="true" />
                </div>
              </template>
              <VListItemTitle>{{ getItemLabel(itemId) }}</VListItemTitle>
              <template #append>
                <div class="toolbar-customizer-actions">
                  <VBtn icon="mdi-chevron-up" size="small" variant="text" :disabled="index === 0" :aria-label="`項目 ${index + 1} を上へ`" @click="moveItem(index, -1)" />
                  <VBtn icon="mdi-chevron-down" size="small" variant="text" :disabled="index === displayedItems.length - 1" :aria-label="`項目 ${index + 1} を下へ`" @click="moveItem(index, 1)" />
                  <VBtn icon="mdi-close" size="small" variant="text" :aria-label="`${getItemLabel(itemId)}を削除`" @click="removeItem(index)" />
                </div>
              </template>
            </VListItem>
            <VListItem
              v-if="displayedItems.length === 0"
              title="ステータスバーの項目はありません"
              :class="{ 'toolbar-customizer-item--drop-before': insertionIndex === 0 }"
              @dragover.prevent.stop="onEndDragOver"
              @drop.prevent.stop="dropItem($event, null)"
            />
            <div
              v-if="displayedItems.length > 0"
              class="toolbar-customizer-drop-end"
              :class="{ 'toolbar-customizer-drop-end--active': insertionIndex === displayedItems.length }"
              aria-hidden="true"
              @dragover.prevent.stop="onEndDragOver"
              @drop.prevent.stop="dropItem($event, null)"
            />
          </VList>
        </section>
      </div>
      <span class="toolbar-customizer-live-region" aria-live="polite" aria-atomic="true">{{ announcement }}</span>
      <div class="setting-actions toolbar-reset-actions">
        <VBtn size="small" variant="outlined" @click="emit('resetStatusBar')">ステータスバーを初期状態に戻す</VBtn>
      </div>
    </template>
  </SettingExpansionSection>
</template>
