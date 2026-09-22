<script setup lang="ts">
import SettingExpansionSection from './SettingExpansionSection.vue'
import SettingSubsection from './SettingSubsection.vue'
import type { EditorSettings, NarrowWrapBehavior, WrapMode } from './editorSettings'
import type { SettingsSectionDefinition, SettingsSectionId } from './settingsDefinitions'

defineProps<{
  editor: EditorSettings
  columnsInput: string
  columnError: string
  headingLevel: number
  sections: readonly SettingsSectionDefinition[]
  expandedSectionIds: readonly SettingsSectionId[]
}>()

const emit = defineEmits<{
  updateEditor: [editor: Partial<EditorSettings>]
  columnsInput: [value: string | number | null]
  columnsCommit: []
  restoreField: [field: keyof EditorSettings]
  toggleSection: [sectionId: SettingsSectionId, expanded: boolean]
}>()

/** 現在の折り返し方法を親へ通知して共通の設定更新経路へ送る。 */
function setWrapMode(mode: WrapMode): void {
  emit('updateEditor', { wrapMode: mode })
}

/** 窓より指定桁数が広い場合の動作を親へ通知する。 */
function setNarrowBehavior(behavior: NarrowWrapBehavior): void {
  emit('updateEditor', { narrowWrapBehavior: behavior })
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
    <template #status>
      <VChip v-if="section.id === 'editor.wrapping.behavior' && columnError" color="error" size="x-small" variant="tonal" aria-label="指定桁数に入力エラーがあります">
        入力エラー
      </VChip>
    </template>
    <template v-if="section.id === 'editor.wrapping.behavior'">
      <VRadioGroup :model-value="editor.wrapMode" aria-label="折り返し方法">
        <VRadio value="window" label="右端で折り返し" @change="setWrapMode('window')" />
        <VRadio value="columns" label="指定桁数で折り返し" @change="setWrapMode('columns')" />
        <VRadio value="none" label="折り返さない" @change="setWrapMode('none')" />
      </VRadioGroup>
      <div class="setting-actions">
        <VBtn size="small" variant="outlined" @click="emit('restoreField', 'wrapMode')">初期値に戻す</VBtn>
      </div>

      <VExpandTransition>
        <div v-if="editor.wrapMode === 'columns'" class="setting-children" role="group" aria-labelledby="wrap-children-title">
          <VSheet class="setting-children-sheet" color="surface-light" rounded="lg" border>
            <component :is="`h${headingLevel + 1}`" id="wrap-children-title" class="setting-children-title">指定桁数で折り返す場合の設定</component>
            <SettingSubsection title="指定桁数" :heading-level="headingLevel + 2">
              <p class="setting-subsection-description">現在の書体で、おおよその表示幅を指定します。</p>
              <VTextField
                :model-value="columnsInput"
                label="桁数"
                type="text"
                inputmode="numeric"
                min="1"
                max="500"
                aria-describedby="columns-help"
                :error-messages="columnError ? [columnError] : []"
                @update:model-value="emit('columnsInput', $event)"
                @blur="emit('columnsCommit')"
                @keydown.enter.prevent="emit('columnsCommit')"
              />
              <p id="columns-help" class="setting-help">1～500の整数で指定します。</p>
              <template #actions>
                <VBtn size="small" variant="outlined" @click="emit('restoreField', 'wrapColumns')">初期値に戻す</VBtn>
              </template>
            </SettingSubsection>
            <VDivider class="setting-children-divider" />
            <SettingSubsection title="指定桁数が窓より広い場合" :heading-level="headingLevel + 2">
              <VRadioGroup :model-value="editor.narrowWrapBehavior" aria-label="指定桁数が窓より広い場合">
                <VRadio value="scroll" label="指定桁数を優先して横スクロール" @change="setNarrowBehavior('scroll')" />
                <VRadio value="fit" label="窓幅に合わせて早めに折り返す" @change="setNarrowBehavior('fit')" />
              </VRadioGroup>
              <template #actions>
                <VBtn size="small" variant="outlined" @click="emit('restoreField', 'narrowWrapBehavior')">初期値に戻す</VBtn>
              </template>
            </SettingSubsection>
          </VSheet>
        </div>
      </VExpandTransition>
    </template>
  </SettingExpansionSection>
</template>
