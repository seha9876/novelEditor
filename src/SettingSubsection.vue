<script setup lang="ts">
defineProps<{
  title: string
}>()
</script>

<template>
  <section class="setting-subsection">
    <div class="setting-subsection-heading">
      <h3 class="setting-subsection-title">{{ title }}</h3>
    </div>
    <div class="setting-subsection-content">
      <slot />
    </div>
    <div v-if="$slots.actions" class="setting-actions setting-subsection-actions">
      <slot name="actions" />
    </div>
  </section>
</template>
