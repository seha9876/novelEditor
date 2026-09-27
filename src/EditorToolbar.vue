
<script setup lang="ts">
import { ref, toRefs } from 'vue'
import type { AppCommand, CommandId } from './appCommands'
import type { EditorSettings } from './editorSettings'
import type { ToolbarItem } from './appPreferenceSchema'

const props = defineProps<{
  toolbarItems: ToolbarItem[]
  editorSettings: EditorSettings
  appCommands: Record<CommandId, AppCommand>
  isCommandDisabled: (commandId: CommandId) => boolean
  isCommandChecked: (commandId: CommandId) => boolean
  getCommandLabel: (commandId: CommandId) => string
}>()
const emit = defineEmits<{
  command: [commandId: CommandId]
  'toolbar-context-menu': []
  'adjust-font-size': [direction: -1 | 1]
  'adjust-line-height': [direction: -1 | 1]
}>()
const {
  toolbarItems,
  editorSettings,
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
        <div v-else-if="item.commandId === 'toolbar.typography.fontSizeAdjust'" class="toolbar-step-adjust" role="group" aria-label="文字サイズを1pxずつ変更">
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
        <div v-else-if="item.commandId === 'toolbar.typography.lineHeight'" class="toolbar-step-adjust" role="group" aria-label="行間を0.1ずつ変更">
          <VBtn
            icon
            class="toolbar-line-height-button"
            size="small"
            variant="text"
            :disabled="isCommandDisabled(item.commandId) || editorSettings.lineHeight <= 1"
            aria-label="行間を0.1狭くする"
            title="行間を0.1狭くする"
            @click="emit('adjust-line-height', -1)"
          >
            <span class="toolbar-composite-icon" aria-hidden="true">
              <VIcon class="toolbar-step-primary-icon" icon="mdi-format-line-spacing" aria-hidden="true" />
              <VIcon class="toolbar-step-badge" icon="mdi-minus" aria-hidden="true" />
            </span>
          </VBtn>
          <VBtn
            icon
            class="toolbar-line-height-button"
            size="small"
            variant="text"
            :disabled="isCommandDisabled(item.commandId) || editorSettings.lineHeight >= 3"
            aria-label="行間を0.1広くする"
            title="行間を0.1広くする"
            @click="emit('adjust-line-height', 1)"
          >
            <span class="toolbar-composite-icon" aria-hidden="true">
              <VIcon class="toolbar-step-primary-icon" icon="mdi-format-line-spacing" aria-hidden="true" />
              <VIcon class="toolbar-step-badge" icon="mdi-plus" aria-hidden="true" />
            </span>
          </VBtn>
        </div>
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
