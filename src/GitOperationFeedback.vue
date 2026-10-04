<script setup lang="ts">
import type { describeGitFailure } from './gitHistoryPresentation'
defineProps<{ feedback: ReturnType<typeof describeGitFailure> }>()
</script>

<template>
  <VAlert :type="feedback.tone" variant="tonal" class="git-feedback mb-3" role="alert">
    <p><strong>{{ feedback.message }}</strong></p>
    <p class="mt-2">{{ feedback.action }}</p>
    <p v-if="feedback.output && !feedback.outputIsRecord" class="mt-2">確認する出力先: {{ feedback.output }}</p>
    <details class="mt-2">
      <summary>詳しい理由</summary>
      <p v-if="feedback.output && feedback.outputIsRecord" class="mt-2">記録ID: {{ feedback.output }}</p>
      <pre>{{ feedback.details }}</pre>
    </details>
  </VAlert>
</template>

<style scoped>
.git-feedback { overflow-wrap: anywhere; }
.git-feedback p { margin: 0; }
.git-feedback pre { white-space: pre-wrap; font-family: inherit; margin-top: 8px; }
.git-feedback summary { cursor: pointer; }
</style>
