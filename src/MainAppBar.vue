<script setup lang="ts">
import MainMenuBar from './MainMenuBar.vue'
import EditorToolbar from './EditorToolbar.vue'
import { ref } from 'vue'
import type { AppCommand, CommandId } from './appCommands'
import type { EditorSettings } from './editorSettings'
import type { ToolbarItem } from './appPreferenceSchema'
import type { ProjectTreeProject } from './projectTreeModel'

const props = defineProps<{
  menuHeight: number
  toolbarHeight: number
  toolbarVisible: boolean
  toolbarItems: ToolbarItem[]
  editorSettings: EditorSettings
  toolbarFontItems: { title: string; value: string }[]
  displayName: string
  documentPath: string | null
  dirty: boolean
  maximized: boolean
  alwaysOnTop: boolean
  appCommands: Record<CommandId, AppCommand>
  isCommandDisabled: (commandId: CommandId) => boolean
  isCommandChecked: (commandId: CommandId) => boolean
  getCommandLabel: (commandId: CommandId) => string
  getCommandShortcut: (commandId: CommandId) => string | undefined
  projects: readonly ProjectTreeProject[]
  activeProjectId: number | null
  projectMenuDisabled: boolean
}>()
const emit = defineEmits<{
  command: [commandId: CommandId]
  'toggle-maximize': []
  'update-font-family': [value: unknown]
  'update-typography-number': [field: 'fontSize' | 'lineHeight', value: number]
  'adjust-font-size': [direction: -1 | 1]
  'project-create': []
  'project-select': [projectId: number]
  'project-rename': []
  'project-delete': []
}>()

const mainMenuBar = ref<{ closeMenus: () => void } | null>(null)

/** 子ツールバーの本文設定値変更を型付きイベントとして親へ渡す。 */
function forwardTypographyNumber(field: 'fontSize' | 'lineHeight', value: number): void {
  emit('update-typography-number', field, value)
}

/** ツールバーとメニューバーが同時に開かないよう、子コンポーネント間の表示状態を同期する。 */
function closeMainMenusForToolbar(): void {
  mainMenuBar.value?.closeMenus()
}
</script>

<template>
  <VAppBar
    class="titlebar"
    :height="props.menuHeight"
    :extended="props.toolbarVisible"
    :extension-height="props.toolbarHeight"
    flat
  >
    <MainMenuBar
      ref="mainMenuBar"
      :toolbar-visible="props.toolbarVisible"
      :editor-settings="props.editorSettings"
      :display-name="props.displayName"
      :document-path="props.documentPath"
      :dirty="props.dirty"
      :maximized="props.maximized"
      :always-on-top="props.alwaysOnTop"
      :is-command-disabled="props.isCommandDisabled"
      :get-command-shortcut="props.getCommandShortcut"
      :projects="props.projects"
      :active-project-id="props.activeProjectId"
      :project-menu-disabled="props.projectMenuDisabled"
      @command="emit('command', $event)"
      @toggle-maximize="emit('toggle-maximize')"
      @project-create="emit('project-create')"
      @project-select="emit('project-select', $event)"
      @project-rename="emit('project-rename')"
      @project-delete="emit('project-delete')"
    />
    <template #extension>
      <EditorToolbar
        v-if="props.toolbarVisible"
        :toolbar-items="props.toolbarItems"
        :editor-settings="props.editorSettings"
        :toolbar-font-items="props.toolbarFontItems"
        :app-commands="props.appCommands"
        :is-command-disabled="props.isCommandDisabled"
        :is-command-checked="props.isCommandChecked"
        :get-command-label="props.getCommandLabel"
        @command="emit('command', $event)"
        @update-font-family="emit('update-font-family', $event)"
        @update-typography-number="forwardTypographyNumber"
        @adjust-font-size="emit('adjust-font-size', $event)"
        @toolbar-context-menu="closeMainMenusForToolbar"
      />
    </template>
  </VAppBar>
</template>
