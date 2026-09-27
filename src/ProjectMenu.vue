<!-- Sidebarとメニューバーで共通利用するプロジェクト操作メニュー。 -->
<script setup lang="ts">
import { toRef } from 'vue'
import type { ProjectTreeProject } from './projectTreeModel'
import { useProjectMenuState } from './useProjectMenuState'

const props = withDefaults(defineProps<{
  projects: readonly ProjectTreeProject[]
  activeProjectId: number | null
  disabled?: boolean
  mode?: 'icon' | 'text'
  modelValue: boolean
}>(), {
  disabled: false,
  mode: 'icon',
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  create: []
  select: [projectId: number]
  rename: []
  delete: []
}>()

const menuState = useProjectMenuState({
  modelValue: toRef(props, 'modelValue'),
  onUpdateModelValue: (value) => emit('update:modelValue', value),
})
const { menuOpen, switchMenuOpen, runAction, closeMenus, closeSubmenu } = menuState

/** 現在のプロジェクトを選択済みとして表示する。 */
function isActive(projectId: number): boolean {
  return projectId === props.activeProjectId
}

defineExpose({ closeMenus, closeSubmenu })
</script>

<template>
  <VMenu
    v-model="menuOpen"
    :location="props.mode === 'icon' ? 'bottom start' : undefined"
    :transition="props.mode === 'text' ? false : undefined"
    :disabled="props.disabled"
    :close-on-content-click="false"
  >
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
    <VList class="project-menu-list" density="compact" min-width="220" role="menu" aria-label="プロジェクト">
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
