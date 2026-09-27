
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, toRefs } from 'vue'
import type { CommandId } from './appCommands'
import type { EditorSettings } from './editorSettings'
import type { ProjectTreeProject } from './projectTreeModel'
import ProjectMenu from './ProjectMenu.vue'
import { useMainMenuState } from './useMainMenuState'

type MainMenuBarProps = {
  toolbarVisible: boolean
  editorSettings: EditorSettings
  displayName: string
  documentPath: string | null
  dirty: boolean
  maximized: boolean
  alwaysOnTop: boolean
  isCommandDisabled: (commandId: CommandId) => boolean
  getCommandShortcut: (commandId: CommandId) => string | undefined
  projects: readonly ProjectTreeProject[]
  activeProjectId: number | null
  projectMenuDisabled: boolean
}

const props = defineProps<MainMenuBarProps>()
const emit = defineEmits<{
  command: [commandId: CommandId]
  'toggle-maximize': []
  'project-create': []
  'project-select': [projectId: number]
  'project-rename': []
  'project-delete': []
}>()

const {
  toolbarVisible,
  editorSettings,
  displayName,
  documentPath,
  dirty,
  maximized,
  alwaysOnTop,
  isCommandDisabled,
  getCommandShortcut,
  projects,
  activeProjectId,
  projectMenuDisabled,
} = toRefs(props)

const projectMenu = ref<{ closeMenus: () => void; closeSubmenu: () => boolean } | null>(null)
const menuState = useMainMenuState({
  closeProjectSubmenu: () => projectMenu.value?.closeSubmenu() ?? false,
  closeProjectMenus: () => { projectMenu.value?.closeMenus() },
})
const {
  settingsSubmenuOpen,
  fileMenuOpen,
  editMenuOpen,
  projectMenuOpen,
  settingsMenuOpen,
  displayMenuOpen,
  windowMenuOpen,
  closeMenus,
  runProjectAction,
  handleEscape,
} = menuState

/** メニュー項目から親画面の共通コマンドを実行する。 */
function runMenuCommand(commandId: CommandId): void {
  closeMenus()
  emit('command', commandId)
}

/** タイトルバーのウィンドウ操作を親画面の共通コマンドへ渡す。 */
function executeCommand(commandId: CommandId): void {
  emit('command', commandId)
}

/** Escでメニューを閉じ、通常のショートカットは親画面へ委ねる。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && handleEscape()) {
    event.preventDefault()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

defineExpose({ closeMenus })
</script>

<template>
  <nav class="menu-bar" aria-label="メニューバー">
    <VMenu v-model="fileMenuOpen" :close-on-content-click="false" :transition="false">
      <template #activator="{ props: fileMenuProps }">
        <VBtn v-bind="fileMenuProps" class="menu-heading" size="small" variant="text">ファイル</VBtn>
      </template>
      <VList density="compact" min-width="220" role="menu" aria-label="ファイル">
        <VListItem role="menuitem" :disabled="isCommandDisabled('document.new')" title="新規" @click="runMenuCommand('document.new')">
          <template #append><span class="menu-shortcut">{{ getCommandShortcut('document.new') }}</span></template>
        </VListItem>
        <VListItem role="menuitem" :disabled="isCommandDisabled('document.open')" title="開く" @click="runMenuCommand('document.open')">
          <template #append><span class="menu-shortcut">{{ getCommandShortcut('document.open') }}</span></template>
        </VListItem>
        <VListItem role="menuitem" :disabled="isCommandDisabled('document.save')" title="保存" @click="runMenuCommand('document.save')">
          <template #append><span class="menu-shortcut">{{ getCommandShortcut('document.save') }}</span></template>
        </VListItem>
        <VListItem role="menuitem" :disabled="isCommandDisabled('document.saveAs')" title="名前を付けて保存" @click="runMenuCommand('document.saveAs')">
          <template #append><span class="menu-shortcut">{{ getCommandShortcut('document.saveAs') }}</span></template>
        </VListItem>
      </VList>
    </VMenu>
    <VMenu v-model="editMenuOpen" :close-on-content-click="false" :transition="false">
      <template #activator="{ props: editMenuProps }">
        <VBtn v-bind="editMenuProps" class="menu-heading" size="small" variant="text">編集</VBtn>
      </template>
      <VList density="compact" min-width="220" role="menu" aria-label="編集">
        <VListItem role="menuitem" :disabled="isCommandDisabled('edit.find')" title="検索" @click="runMenuCommand('edit.find')">
          <template #append><span class="menu-shortcut">{{ getCommandShortcut('edit.find') }}</span></template>
        </VListItem>
        <VListItem role="menuitem" :disabled="isCommandDisabled('edit.replace')" title="置換" @click="runMenuCommand('edit.replace')">
          <template #append><span class="menu-shortcut">{{ getCommandShortcut('edit.replace') }}</span></template>
        </VListItem>
      </VList>
    </VMenu>
    <ProjectMenu
      ref="projectMenu"
      v-model="projectMenuOpen"
      mode="text"
      :projects="projects"
      :active-project-id="activeProjectId"
      :disabled="projectMenuDisabled"
      @create="runProjectAction(() => emit('project-create'))"
      @select="runProjectAction(() => emit('project-select', $event))"
      @rename="runProjectAction(() => emit('project-rename'))"
      @delete="runProjectAction(() => emit('project-delete'))"
    />
    <VMenu v-model="settingsMenuOpen" :close-on-content-click="false" :transition="false">
      <template #activator="{ props: settingsMenuProps }">
        <VBtn v-bind="settingsMenuProps" class="menu-heading" size="small" variant="text">設定</VBtn>
      </template>
      <VList density="compact" min-width="240" role="menu" aria-label="設定">
        <VListItem role="menuitem" title="設定画面を開く" @click="runMenuCommand('settings.open')" />
        <VDivider class="my-1" />
        <VMenu v-model="settingsSubmenuOpen" location="end" open-on-hover :close-on-content-click="false" :open-delay="100" :close-delay="200">
          <template #activator="{ props: submenuProps }">
            <VListItem v-bind="submenuProps" role="menuitem" title="折り返し設定" append-icon="mdi-chevron-right" />
          </template>
          <VList density="compact" min-width="240" role="menu" aria-label="折り返し設定">
            <VListItem role="menuitemradio" :aria-checked="editorSettings.wrapMode === 'window'" :active="editorSettings.wrapMode === 'window'" title="右端で折り返し" @click="runMenuCommand('wrap.window')">
              <template #prepend><VIcon icon="mdi-check" :style="{ visibility: editorSettings.wrapMode === 'window' ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
            </VListItem>
            <VListItem role="menuitemradio" :aria-checked="editorSettings.wrapMode === 'columns'" :active="editorSettings.wrapMode === 'columns'" title="指定桁数で折り返し" @click="runMenuCommand('wrap.columns')">
              <template #prepend><VIcon icon="mdi-check" :style="{ visibility: editorSettings.wrapMode === 'columns' ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
            </VListItem>
            <VListItem role="menuitemradio" :aria-checked="editorSettings.wrapMode === 'none'" :active="editorSettings.wrapMode === 'none'" title="折り返さない" @click="runMenuCommand('wrap.none')">
              <template #prepend><VIcon icon="mdi-check" :style="{ visibility: editorSettings.wrapMode === 'none' ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
            </VListItem>
          </VList>
        </VMenu>
      </VList>
    </VMenu>
    <VMenu v-model="displayMenuOpen" :close-on-content-click="false" :transition="false">
      <template #activator="{ props: displayMenuProps }">
        <VBtn v-bind="displayMenuProps" class="menu-heading" size="small" variant="text">表示</VBtn>
      </template>
      <VList density="compact" min-width="240" role="menu" aria-label="表示">
        <VListItem role="menuitemcheckbox" :aria-checked="toolbarVisible" :active="toolbarVisible" title="ツールバーを表示" @click="runMenuCommand('view.toolbar.toggle')">
          <template #prepend><VIcon icon="mdi-check" :style="{ visibility: toolbarVisible ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
        </VListItem>
        <VListItem role="menuitem" title="ツールバーをカスタマイズ…" @click="runMenuCommand('view.toolbar.customize')" />
      </VList>
    </VMenu>
    <VMenu v-model="windowMenuOpen" :close-on-content-click="false" :transition="false">
      <template #activator="{ props: windowMenuProps }">
        <VBtn v-bind="windowMenuProps" class="menu-heading" size="small" variant="text">ウィンドウ</VBtn>
      </template>
      <VList density="compact" min-width="260" role="menu" aria-label="ウィンドウ">
        <VListItem role="menuitem" title="最小化" @click="runMenuCommand('window.minimize')" />
        <VListItem role="menuitem" title="最大化" @click="runMenuCommand('window.maximize')" />
        <VListItem role="menuitem" title="縦方向に最大化" @click="runMenuCommand('window.maximizeVertical')" />
        <VListItem role="menuitem" title="横方向に最大化" @click="runMenuCommand('window.maximizeHorizontal')" />
        <VListItem role="menuitemcheckbox" :aria-checked="alwaysOnTop" :active="alwaysOnTop" title="常に手前に表示" @click="runMenuCommand('window.alwaysOnTop')">
          <template #prepend><VIcon icon="mdi-check" :style="{ visibility: alwaysOnTop ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
        </VListItem>
        <VDivider class="my-1" />
        <VListItem role="menuitem" title="閉じる" @click="runMenuCommand('window.close')" />
      </VList>
    </VMenu>
    <VBtn class="menu-heading menu-placeholder" size="small" variant="text" disabled>ヘルプ</VBtn>
  </nav>
  <div class="titlebar-drag-region" data-tauri-drag-region :title="documentPath ?? '新規文書'">
    <div class="document-title">
      <span class="file-name">{{ displayName }}</span>
      <span v-if="dirty" class="dirty-indicator" aria-label="未保存">未保存</span>
    </div>
  </div>
  <div class="window-controls" aria-label="ウィンドウ操作">
    <VBtn icon variant="text" size="small" aria-label="最小化" title="最小化" @click="executeCommand('window.minimize')"><VIcon icon="mdi-minus" aria-hidden="true" /></VBtn>
    <VBtn icon variant="text" size="small" :aria-label="maximized ? '元に戻す' : '最大化'" :title="maximized ? '元に戻す' : '最大化'" @click="emit('toggle-maximize')"><VIcon :icon="maximized ? 'mdi-window-restore' : 'mdi-square-outline'" aria-hidden="true" /></VBtn>
    <VBtn class="window-close" icon variant="text" size="small" aria-label="閉じる" title="閉じる" @click="executeCommand('window.close')"><VIcon icon="mdi-close" aria-hidden="true" /></VBtn>
  </div>
</template>
