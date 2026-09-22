<script setup lang="ts">
defineProps<{
  title: string
  modified: boolean
}>()
</script>

<template>
  <section class="setting-subsection">
    <div class="setting-subsection-heading">
      <h3 class="setting-subsection-title">{{ title }}</h3>
      <VChip
        v-if="modified"
        class="setting-pending"
        size="x-small"
        variant="tonal"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        未保存
      </VChip>
    </div>
    <div class="setting-subsection-content">
      <slot />
    </div>
    <div v-if="$slots.actions" class="setting-actions setting-subsection-actions">
      <slot name="actions" />
    </div>
  </section>
</template>
