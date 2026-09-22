<script setup lang="ts">
import type { SettingsSectionDefinition } from './settingsDefinitions'

defineProps<{
  section: SettingsSectionDefinition
  headingLevel: number
  expanded: boolean
}>()

const emit = defineEmits<{
  updateExpanded: [expanded: boolean]
}>()
</script>

<template>
  <VExpansionPanels
    :model-value="expanded ? [section.id] : []"
    multiple
    variant="default"
    class="setting-expansion-panels"
    @update:model-value="emit('updateExpanded', $event.includes(section.id))"
  >
    <VExpansionPanel :value="section.id" class="setting-expansion-section">
      <component :is="`h${headingLevel}`" :id="`${section.id}-heading`" class="setting-expansion-heading">
        <VExpansionPanelTitle>
          <span class="setting-expansion-title">{{ section.label }}</span>
          <slot name="status" />
        </VExpansionPanelTitle>
      </component>
      <VExpansionPanelText>
        <slot />
      </VExpansionPanelText>
    </VExpansionPanel>
  </VExpansionPanels>
</template>
