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
  'adjust-font-size': [direction: -1 | 1]
  'adjust-line-height': [direction: -1 | 1]
  'project-create': []
  'project-select': [projectId: number]
  'project-rename': []
  'project-delete': []
}>()

const mainMenuBar = ref<{ closeMenus: () => void } | null>(null)

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
        :app-commands="props.appCommands"
        :is-command-disabled="props.isCommandDisabled"
        :is-command-checked="props.isCommandChecked"
        :get-command-label="props.getCommandLabel"
        @command="emit('command', $event)"
        @adjust-font-size="emit('adjust-font-size', $event)"
        @adjust-line-height="emit('adjust-line-height', $event)"
        @toolbar-context-menu="closeMainMenusForToolbar"
      />
    </template>
  </VAppBar>
</template>
