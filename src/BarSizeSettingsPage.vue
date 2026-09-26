<script setup lang="ts">
import SettingExpansionSection from './SettingExpansionSection.vue'
import { interfaceBarSizePresets, type InterfaceBarSizes, type InterfaceSize } from './appPreferences'
import type { SettingsSectionDefinition, SettingsSectionId } from './settingsDefinitions'

defineProps<{
  barSizes: InterfaceBarSizes
  headingLevel: number
  sections: readonly SettingsSectionDefinition[]
  expandedSectionIds: readonly SettingsSectionId[]
}>()

const emit = defineEmits<{
  updateBarSizes: [barSizes: Partial<InterfaceBarSizes>, flush?: boolean]
  toggleSection: [sectionId: SettingsSectionId, expanded: boolean]
}>()

const sizeOptions: ReadonlyArray<{ value: InterfaceSize; label: string }> = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
]

/** 選択されたサイズ値が設定で扱える3段階か検査する。 */
function isInterfaceSize(value: unknown): value is InterfaceSize {
  return value === 'small' || value === 'medium' || value === 'large'
}

/** 指定したバーのサイズを即時反映し、メイン画面の自動保存経路へ渡す。 */
function changeBarSize(bar: keyof InterfaceBarSizes, value: unknown): void {
  if (!isInterfaceSize(value)) return
  emit('updateBarSizes', { [bar]: value })
}

/** 選択肢に対応する高さを説明文へ表示する。px値の入力は受け付けない。 */
function describeHeight(bar: keyof InterfaceBarSizes, size: InterfaceSize): string {
  return `${interfaceBarSizePresets[size][bar].height}px`
}
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
    <template v-if="section.id === 'appearance.bars.sizes'">
      <p class="setting-help bar-size-help">表示領域に合わせて、各バーの高さと内部コントロールの大きさを調整します。</p>
      <div class="bar-size-options">
        <div class="bar-size-row">
          <div class="bar-size-label">
            <span class="setting-subsection-title">メニューバー</span>
            <span class="setting-help">高さ {{ describeHeight('menu', barSizes.menu) }}</span>
          </div>
          <VBtnToggle
            :model-value="barSizes.menu"
            mandatory
            density="comfortable"
            color="primary"
            variant="outlined"
            :aria-label="`メニューバーのサイズ（現在: ${barSizes.menu}）`"
            @update:model-value="changeBarSize('menu', $event)"
          >
            <VBtn v-for="option in sizeOptions" :key="option.value" :value="option.value">{{ option.label }}</VBtn>
          </VBtnToggle>
        </div>
        <div class="bar-size-row">
          <div class="bar-size-label">
            <span class="setting-subsection-title">ツールバー</span>
            <span class="setting-help">高さ {{ describeHeight('toolbar', barSizes.toolbar) }}</span>
          </div>
          <VBtnToggle
            :model-value="barSizes.toolbar"
            mandatory
            density="comfortable"
            color="primary"
            variant="outlined"
            :aria-label="`ツールバーのサイズ（現在: ${barSizes.toolbar}）`"
            @update:model-value="changeBarSize('toolbar', $event)"
          >
            <VBtn v-for="option in sizeOptions" :key="option.value" :value="option.value">{{ option.label }}</VBtn>
          </VBtnToggle>
        </div>
        <div class="bar-size-row">
          <div class="bar-size-label">
            <span class="setting-subsection-title">ステータスバー</span>
            <span class="setting-help">高さ {{ describeHeight('status', barSizes.status) }}</span>
          </div>
          <VBtnToggle
            :model-value="barSizes.status"
            mandatory
            density="comfortable"
            color="primary"
            variant="outlined"
            :aria-label="`ステータスバーのサイズ（現在: ${barSizes.status}）`"
            @update:model-value="changeBarSize('status', $event)"
          >
            <VBtn v-for="option in sizeOptions" :key="option.value" :value="option.value">{{ option.label }}</VBtn>
          </VBtnToggle>
        </div>
      </div>
    </template>
  </SettingExpansionSection>
</template>
