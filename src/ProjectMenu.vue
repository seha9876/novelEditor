<!-- Sidebarとメニューバーで共通利用するプロジェクト操作メニュー。 -->
<script setup lang="ts">
import { ref } from 'vue'
import type { ProjectTreeProject } from './projectTreeModel'

const props = withDefaults(defineProps<{
  projects: readonly ProjectTreeProject[]
  activeProjectId: number | null
  disabled?: boolean
  mode?: 'icon' | 'text'
}>(), {
  disabled: false,
  mode: 'icon',
})

const emit = defineEmits<{
  create: []
  select: [projectId: number]
  rename: []
  delete: []
}>()

const menuOpen = ref(false)
const switchMenuOpen = ref(false)

/** メニューを閉じ、プロジェクト操作を親のControllerへ渡す。 */
function runAction(action: () => void): void {
  switchMenuOpen.value = false
  menuOpen.value = false
  action()
}

/** 外側のメニューバーが閉じるとき、プロジェクトのサブメニューも閉じる。 */
function closeMenus(): void {
  switchMenuOpen.value = false
  menuOpen.value = false
}

/** 現在のプロジェクトを選択済みとして表示する。 */
function isActive(projectId: number): boolean {
  return projectId === props.activeProjectId
}

defineExpose({ closeMenus })
</script>

<template>
  <VMenu v-model="menuOpen" location="bottom start" :disabled="props.disabled" :close-on-content-click="false">
    <template #activator="{ props: menuProps }">
      <VBtn
        v-if="props.mode === 'icon'"
        v-bind="menuProps"
        class="project-menu-activator"
        icon
        size="small"
        variant="text"
        :disabled="props.disabled"
        aria-label="プロジェクト操作"
        title="プロジェクト操作"
      >
        <VIcon icon="mdi-dots-vertical" aria-hidden="true" />
      </VBtn>
      <VBtn v-else v-bind="menuProps" class="menu-heading" size="small" variant="text" :disabled="props.disabled">プロジェクト</VBtn>
    </template>
    <VList class="project-menu-list" min-width="220" role="menu" aria-label="プロジェクト">
      <VListItem role="menuitem" title="新しいプロジェクト" prepend-icon="mdi-plus" :disabled="props.disabled" @click="runAction(() => emit('create'))" />
      <VMenu v-model="switchMenuOpen" location="end" :close-on-content-click="false">
        <template #activator="{ props: switchMenuProps }">
          <VListItem
            v-bind="switchMenuProps"
            role="menuitem"
            title="プロジェクトを切り替え"
            prepend-icon="mdi-swap-horizontal"
            append-icon="mdi-chevron-right"
            :disabled="props.disabled || props.projects.length === 0"
          />
        </template>
        <VList class="project-menu-switch-list" density="compact" min-width="220" max-height="320" role="menu" aria-label="プロジェクトを切り替え">
          <VListItem
            v-for="project in props.projects"
            :key="project.id"
            role="menuitemradio"
            :aria-checked="isActive(project.id)"
            :active="isActive(project.id)"
            :title="project.name"
            @click="runAction(() => emit('select', project.id))"
          >
            <template #prepend>
              <VIcon icon="mdi-check" :style="{ visibility: isActive(project.id) ? 'visible' : 'hidden' }" aria-hidden="true" />
            </template>
          </VListItem>
        </VList>
      </VMenu>
      <VListItem role="menuitem" title="名前を変更" prepend-icon="mdi-pencil-outline" :disabled="props.disabled || props.activeProjectId === null" @click="runAction(() => emit('rename'))" />
      <VListItem role="menuitem" title="プロジェクトを削除" prepend-icon="mdi-delete-outline" :disabled="props.disabled || props.activeProjectId === null" @click="runAction(() => emit('delete'))" />
    </VList>
  </VMenu>
</template>
