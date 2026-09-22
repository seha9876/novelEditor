<script setup lang="ts">
defineProps<{
  title: string
  headingLevel?: number
}>()
</script>

<template>
  <section class="setting-subsection">
    <div class="setting-subsection-heading">
      <component :is="`h${headingLevel ?? 3}`" class="setting-subsection-title">{{ title }}</component>
    </div>
    <div class="setting-subsection-content">
      <slot />
    </div>
    <div v-if="$slots.actions" class="setting-actions setting-subsection-actions">
      <slot name="actions" />
    </div>
  </section>
</template>
