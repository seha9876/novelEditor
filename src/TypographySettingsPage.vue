<script setup lang="ts">
import { computed } from 'vue'
import SettingExpansionSection from './SettingExpansionSection.vue'
import SettingNumberInput from './SettingNumberInput.vue'
import SettingSubsection from './SettingSubsection.vue'
import { editorFontOptions, type EditorSettings } from './editorSettings'
import type { SettingsSectionDefinition, SettingsSectionId } from './settingsDefinitions'

const props = defineProps<{
  editor: EditorSettings
  values: { fontSize: number; lineHeight: number }
  inputs: { fontSize: string; lineHeight: string }
  errors: { fontSize: string; lineHeight: string }
  headingLevel: number
  sections: readonly SettingsSectionDefinition[]
  expandedSectionIds: readonly SettingsSectionId[]
}>()
const emit = defineEmits<{
  updateEditor: [value: Partial<EditorSettings>]
  numberInput: [field: 'fontSize' | 'lineHeight', value: string]
  numberValue: [field: 'fontSize' | 'lineHeight', value: number]
  numberCommit: [field: 'fontSize' | 'lineHeight']
  numberInteraction: [field: 'fontSize' | 'lineHeight', value: number]
  restoreField: [field: keyof EditorSettings]
  toggleSection: [sectionId: SettingsSectionId, expanded: boolean]
}>()
const fontItems = computed(() => {
  const choices: { title: string; value: string }[] = editorFontOptions.map((option) => ({ title: option.label, value: option.fontFamily }))
  if (!choices.some((option) => option.value === props.editor.fontFamily)) {
    choices.push({ title: props.editor.fontFamily, value: props.editor.fontFamily })
  }
  return choices
})

/** プリセットは書体名と代替書体を同じ履歴変更として送る。 */
function chooseFont(value: string): void {
  const option = editorFontOptions.find((candidate) => candidate.fontFamily === value)
  if (option) emit('updateEditor', { fontFamily: option.fontFamily, fontFallback: option.fontFallback })
}
</script>

<template>
  <SettingExpansionSection
    v-for="section in sections" :key="section.id" :section="section"
    :heading-level="headingLevel" :expanded="expandedSectionIds.includes(section.id)"
    @update-expanded="emit('toggleSection', section.id, $event)"
  >
    <template #status>
      <VChip v-if="errors.fontSize || errors.lineHeight" color="error" size="x-small" variant="tonal">入力エラー</VChip>
    </template>
    <SettingSubsection title="書体" :heading-level="headingLevel + 1">
      <VSelect :model-value="editor.fontFamily" :items="fontItems" label="本文の書体" @update:model-value="chooseFont" />
      <p class="setting-help">未インストールの書体は代替書体で表示します。</p>
      <template #actions>
        <VBtn size="small" variant="outlined" @click="emit('restoreField', 'fontFamily')">初期値に戻す</VBtn>
      </template>
    </SettingSubsection>
    <SettingSubsection title="文字サイズ" :heading-level="headingLevel + 1">
      <SettingNumberInput
        :model-value="values.fontSize" :input-text="inputs.fontSize" label="文字サイズ（px）" :min="12" :max="48" :step="1" :precision="0"
        :error-messages="errors.fontSize ? [errors.fontSize] : []"
        @input-text="emit('numberInput', 'fontSize', $event)"
        @update:model-value="emit('numberValue', 'fontSize', $event)"
        @commit="emit('numberCommit', 'fontSize')"
        @interaction="emit('numberInteraction', 'fontSize', $event)"
      />
      <p class="setting-help">12～48の整数。有効な値は入力中に反映され、範囲外の値はフォーカス移動時に補正されます。</p>
      <template #actions>
        <VBtn size="small" variant="outlined" @click="emit('restoreField', 'fontSize')">初期値に戻す</VBtn>
      </template>
    </SettingSubsection>
    <SettingSubsection title="行間" :heading-level="headingLevel + 1">
      <SettingNumberInput
        :model-value="values.lineHeight" :input-text="inputs.lineHeight" label="文字サイズに対する倍率" :min="1" :max="3" :step="0.1" :precision="1" :min-fraction-digits="1"
        :error-messages="errors.lineHeight ? [errors.lineHeight] : []"
        @input-text="emit('numberInput', 'lineHeight', $event)"
        @update:model-value="emit('numberValue', 'lineHeight', $event)"
        @commit="emit('numberCommit', 'lineHeight')"
        @interaction="emit('numberInteraction', 'lineHeight', $event)"
      />
      <p class="setting-help">1.0～3.0を0.1刻み。有効な値は入力中に反映され、範囲外の値はフォーカス移動時に補正されます。</p>
      <template #actions>
        <VBtn size="small" variant="outlined" @click="emit('restoreField', 'lineHeight')">初期値に戻す</VBtn>
      </template>
    </SettingSubsection>
  </SettingExpansionSection>
</template>
