
<script setup lang="ts">
import { ref, toRefs } from 'vue'
import ToolbarTypographyNumber from './ToolbarTypographyNumber.vue'
import type { AppCommand, CommandId } from './appCommands'
import type { EditorSettings } from './editorSettings'
import type { ToolbarItem } from './appPreferenceSchema'

const props = defineProps<{
  toolbarItems: ToolbarItem[]
  editorSettings: EditorSettings
  toolbarFontItems: { title: string; value: string }[]
  appCommands: Record<CommandId, AppCommand>
  isCommandDisabled: (commandId: CommandId) => boolean
  isCommandChecked: (commandId: CommandId) => boolean
  getCommandLabel: (commandId: CommandId) => string
}>()
const emit = defineEmits<{
  command: [commandId: CommandId]
  'toolbar-context-menu': []
  'update-font-family': [value: unknown]
  'update-typography-number': [field: 'fontSize' | 'lineHeight', value: number]
  'adjust-font-size': [direction: -1 | 1]
}>()
const {
  toolbarItems,
  editorSettings,
  toolbarFontItems,
  appCommands,
  isCommandDisabled,
  isCommandChecked,
  getCommandLabel,
} = toRefs(props)
const toolbarContextMenuOpen = ref(false)
const toolbarContextMenuTarget = ref<[number, number]>([0, 0])

/** ツールバーから親画面の共通コマンドを実行する。 */
function executeCommand(commandId: CommandId): void {
  emit('command', commandId)
}

/** 右クリック位置へツールバーの操作メニューを開く。 */
function openToolbarContextMenu(event: MouseEvent): void {
  event.preventDefault()
  toolbarContextMenuTarget.value = [event.clientX, event.clientY]
  toolbarContextMenuOpen.value = true
  emit('toolbar-context-menu')
}
</script>

<template>
  <div class="toolbar-strip" role="toolbar" aria-label="ツールバー" @contextmenu="openToolbarContextMenu">
    <div class="toolbar-scroll">
      <template v-for="item in toolbarItems" :key="item.type === 'command' ? item.commandId : item.id">
        <VDivider v-if="item.type === 'separator'" class="toolbar-divider" vertical inset />
        <VSelect
          v-else-if="item.commandId === 'toolbar.typography.fontFamily'"
          class="toolbar-typography-font"
          :model-value="editorSettings.fontFamily"
          :items="toolbarFontItems"
          item-title="title"
          item-value="value"
          label="書体"
          density="compact"
          variant="outlined"
          hide-details
          :disabled="isCommandDisabled(item.commandId)"
          aria-label="本文の書体"
          @update:model-value="emit('update-font-family', $event)"
        />
        <ToolbarTypographyNumber
          v-else-if="item.commandId === 'toolbar.typography.fontSize'"
          :model-value="editorSettings.fontSize"
          field="fontSize"
          label="サイズ"
          suffix="px"
          :disabled="isCommandDisabled(item.commandId)"
          @update:model-value="emit('update-typography-number', 'fontSize', $event)"
        />
        <div v-else-if="item.commandId === 'toolbar.typography.fontSizeAdjust'" class="toolbar-font-size-adjust" role="group" aria-label="文字サイズを1pxずつ変更">
          <VBtn
            icon="mdi-format-font-size-decrease"
            size="small"
            variant="text"
            :disabled="isCommandDisabled(item.commandId) || editorSettings.fontSize <= 12"
            aria-label="文字サイズを1px小さくする"
            title="文字サイズを1px小さくする"
            @click="emit('adjust-font-size', -1)"
          />
          <VBtn
            icon="mdi-format-font-size-increase"
            size="small"
            variant="text"
            :disabled="isCommandDisabled(item.commandId) || editorSettings.fontSize >= 48"
            aria-label="文字サイズを1px大きくする"
            title="文字サイズを1px大きくする"
            @click="emit('adjust-font-size', 1)"
          />
        </div>
        <ToolbarTypographyNumber
          v-else-if="item.commandId === 'toolbar.typography.lineHeight'"
          :model-value="editorSettings.lineHeight"
          field="lineHeight"
          label="行間"
          suffix="倍"
          :disabled="isCommandDisabled(item.commandId)"
          @update:model-value="emit('update-typography-number', 'lineHeight', $event)"
        />
        <VTooltip v-else :text="getCommandLabel(item.commandId)" location="bottom">
          <template #activator="{ props: tooltipProps }">
            <VBtn
              v-bind="tooltipProps"
              class="toolbar-command"
              icon
              size="small"
              :variant="isCommandChecked(item.commandId) ? 'tonal' : 'text'"
              :color="isCommandChecked(item.commandId) ? 'primary' : undefined"
              :disabled="isCommandDisabled(item.commandId)"
              :aria-label="getCommandLabel(item.commandId)"
              :aria-pressed="['wrap.window', 'wrap.columns', 'wrap.none', 'window.alwaysOnTop'].includes(item.commandId) ? isCommandChecked(item.commandId) : undefined"
              @click="executeCommand(item.commandId)"
            >
              <VIcon :icon="appCommands[item.commandId].icon" aria-hidden="true" />
            </VBtn>
          </template>
        </VTooltip>
      </template>
    </div>
  </div>
  <VMenu v-model="toolbarContextMenuOpen" :target="toolbarContextMenuTarget" location="bottom start" :close-on-content-click="true">
    <VList density="compact" min-width="240" role="menu" aria-label="ツールバー操作">
      <VListItem role="menuitem" title="ツールバーをカスタマイズ…" @click="executeCommand('view.toolbar.customize')" />
      <VDivider class="my-1" />
      <VListItem role="menuitem" title="ツールバーを非表示" @click="executeCommand('view.toolbar.toggle')" />
    </VList>
  </VMenu>
</template>
