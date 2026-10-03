<script setup lang="ts">
import type { FileConflict } from './externalFile'
import { sameRecentFilePath } from './recentFiles'

defineProps<{ conflict: FileConflict | null; currentPath: string | null; pending: boolean }>()
const emit = defineEmits<{ reload: []; saveAs: []; overwrite: []; retry: []; later: []; closed: [] }>()
</script>

<template>
  <VDialog :model-value="conflict !== null" :persistent="pending" max-width="600" aria-label="外部更新の確認" @update:model-value="emit('later')" @after-leave="emit('closed')">
    <VCard v-if="conflict">
      <VCardTitle>外部更新の確認</VCardTitle>
      <VCardText>
        <p class="external-file-path">{{ conflict.path }}</p>
        <p v-if="conflict.disk.kind === 'present'">外部で内容が変更されています。現在の本文は保持しています。</p>
        <p v-else-if="conflict.disk.kind === 'missing'">ファイルが見つかりません。移動または削除された可能性があります。</p>
        <VAlert v-else type="error" variant="tonal" role="alert">{{ conflict.disk.message }}</VAlert>
        <p v-if="conflict.disk.kind === 'present' && currentPath && sameRecentFilePath(conflict.path, currentPath)" class="external-file-help">再読込すると本文の編集履歴は初期化されます。</p>
        <p class="external-file-help">別名保存なら現在の本文を別のファイルに残せます。</p>
      </VCardText>
      <VCardActions class="external-file-actions">
        <VBtn v-if="conflict.disk.kind === 'present' && currentPath && sameRecentFilePath(conflict.path, currentPath)" :disabled="pending" @click="emit('reload')">再読込</VBtn>
        <VBtn :disabled="pending" @click="emit('saveAs')">名前を付けて保存</VBtn>
        <VBtn v-if="conflict.disk.kind !== 'error'" :disabled="pending" @click="emit('overwrite')">{{ conflict.disk.kind === 'missing' ? '同じ場所に再作成' : '現在の本文で上書き' }}</VBtn>
        <VBtn v-else :disabled="pending" @click="emit('retry')">再確認</VBtn>
        <VBtn :disabled="pending" @click="emit('later')">後で</VBtn>
      </VCardActions>
    </VCard>
  </VDialog>
</template>

<style scoped>
.external-file-path { overflow-wrap: anywhere; margin-bottom: 12px; }
.external-file-help { color: var(--app-muted); font-size: 0.8125rem; margin-top: 12px; }
.external-file-actions { flex-wrap: wrap; }
</style>
