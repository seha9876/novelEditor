<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { sidebarPanels, type SidebarPanelId } from './sidebarModel'
const props = defineProps<{ activePanel: SidebarPanelId; collapsed: boolean; disabled: boolean; resizing: boolean }>()
const emit = defineEmits<{ select: [panel: SidebarPanelId]; close: [] }>()
const rail = ref<HTMLElement | null>(null), content = ref<HTMLElement | null>(null), focused = ref<SidebarPanelId>(props.activePanel)
/** 隠れるパネルのフォーカスだけを選択ボタンへ戻し、本文の選択には触れない。 */
watch([() => props.activePanel, () => props.collapsed], ([panel], [previousPanel]) => {
  if (panel !== previousPanel) focused.value = panel
  if (content.value?.contains(document.activeElement) || document.activeElement?.classList.contains('project-tree-resize-handle')) focusButton(props.activePanel)
}, { flush: 'sync' })
/** ドラッグ中の無効化で子部品がフォーカスを失う前に、操作を続けられる切替ボタンへ戻す。 */
watch(() => props.resizing, resizing => {
  if (resizing && content.value?.contains(document.activeElement)) focusButton(props.activePanel)
}, { flush: 'sync' })
/** 左端を一つのTab位置にまとめ、矢印移動後の選択を維持する。 */
function focusButton(panel: SidebarPanelId): void { focused.value = panel; rail.value?.querySelector<HTMLButtonElement>(`[data-panel="${panel}"]`)?.focus() }
/** 縦方向のボタン移動だけを行い、パネルはEnter／Spaceで明示して開く。 */
async function onKey(event: KeyboardEvent, panel: SidebarPanelId): Promise<void> {
  if (props.disabled || props.resizing || event.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = sidebarPanels.findIndex(item => item.id === panel)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowDown' ? 1 : 3)) % 4
  await nextTick(); focusButton(sidebarPanels[next]!.id)
}
</script>
<template>
  <div class="sidebar-shell">
    <div ref="rail" class="sidebar-rail" role="toolbar" aria-label="サイドバーのパネル" aria-orientation="vertical">
      <VTooltip v-for="panel in sidebarPanels" :key="panel.id" :text="panel.label" location="right">
        <template #activator="{ props: tooltip }"><VBtn v-bind="tooltip" :data-panel="panel.id" :icon="panel.icon" :aria-label="panel.label" :aria-pressed="activePanel === panel.id && !collapsed" :aria-expanded="activePanel === panel.id && !collapsed" :aria-controls="`sidebar-${panel.id}`" :tabindex="focused === panel.id ? 0 : -1" :disabled="disabled" :aria-disabled="disabled || resizing" variant="text" @focus="focused = panel.id" @keydown="onKey($event, panel.id)" @click="!resizing && emit('select', panel.id)" /></template>
      </VTooltip>
    </div>
    <div v-show="!collapsed" ref="content" class="sidebar-content" :inert="collapsed">
      <header class="sidebar-header"><strong>{{ sidebarPanels.find(panel => panel.id === activePanel)?.label }}</strong><VBtn icon="mdi-chevron-left" variant="text" size="small" aria-label="サイドバーを閉じる" :disabled="disabled" :aria-disabled="disabled || resizing" @click="!resizing && emit('close')" /></header>
      <div class="sidebar-panel-content"><slot /></div>
    </div>
  </div>
</template>
