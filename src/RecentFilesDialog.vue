<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { fileName } from './textFile'
import type { RecentFile } from './recentFiles'

const props = defineProps<{
  modelValue: boolean
  entries: RecentFile[]
  selectedId: number | null
  pending: boolean
  disabled: boolean
  error: string
}>()
const emit = defineEmits<{
  close: []
  closed: []
  select: [id: number]
  move: [direction: -1 | 1]
  openFile: [id: number]
  remove: [id: number | null]
}>()
const content = ref<HTMLElement | null>(null)

/** 一覧の更新後に選択行へフォーカスし、空の場合も閉じるボタンへ到達できるようにする。 */
async function focusSelection(): Promise<void> {
  await nextTick()
  if (!props.modelValue || props.pending || props.disabled) return
  const selected = content.value?.querySelector<HTMLButtonElement>(`[data-recent-id="${props.selectedId}"]`)
  selected?.focus()
  selected?.scrollIntoView({ block: 'nearest' })
  if (!selected) content.value?.querySelector<HTMLButtonElement>('[data-recent-close]')?.focus()
}

watch(() => [props.selectedId, props.pending], () => { void focusSelection() })

/** IMEの取消を優先し、候補上の上下キーだけを一覧内の移動へ割り当てる。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) {
    if (event.key === 'Escape') event.stopPropagation()
    return
  }
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
  if (!(event.target instanceof HTMLElement) || !event.target.closest('[data-recent-id]')) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    emit('move', event.key === 'ArrowDown' ? 1 : -1)
  }
}
</script>

<template>
  <VDialog :model-value="modelValue" :persistent="pending" max-width="700" aria-label="最近開いたファイル" @update:model-value="emit('close')" @after-enter="focusSelection" @after-leave="emit('closed')">
    <VCard>
      <div ref="content" @keydown="onKeydown">
        <VCardTitle>最近開いたファイル</VCardTitle>
        <VCardText>
          <p class="recent-files-help">最新20件を表示します。履歴を削除しても実ファイルは残ります。</p>
          <VProgressLinear v-if="pending" indeterminate aria-label="履歴を処理中" />
          <VAlert v-if="error" type="error" variant="tonal" class="mb-3" role="alert">{{ error }}</VAlert>
          <p v-if="!pending && !entries.length" role="status">{{ error ? '履歴を表示できません。閉じてからもう一度開いてください。' : '最近開いたファイルはありません。' }}</p>
          <ul class="recent-files-list" :aria-busy="pending" aria-label="ファイル履歴">
            <li v-for="entry in entries" :key="entry.id" class="recent-files-row">
              <button
                type="button" class="recent-file-open" :class="{ 'is-selected': selectedId === entry.id }"
                :data-recent-id="entry.id" :title="entry.path" :disabled="pending || disabled"
                @focus="emit('select', entry.id)" @click="emit('openFile', entry.id)"
              >
                <span class="recent-file-name">{{ fileName(entry.path) }}</span>
                <span class="recent-file-path">{{ entry.path }}</span>
              </button>
              <VBtn icon="mdi-close" size="small" variant="text" :aria-label="`${fileName(entry.path)}を履歴から削除`" title="履歴から削除" :disabled="pending || disabled" @click="emit('remove', entry.id)" />
            </li>
          </ul>
        </VCardText>
        <VCardActions>
          <VBtn :disabled="pending || disabled || !entries.length" @click="emit('remove', null)">履歴をすべて消去</VBtn>
          <VSpacer />
          <VBtn data-recent-close :disabled="pending" @click="emit('close')">閉じる</VBtn>
        </VCardActions>
      </div>
    </VCard>
  </VDialog>
</template>

<style scoped>
.recent-files-help { color: var(--app-muted); font-size: 0.8125rem; margin-bottom: 12px; }
.recent-files-list { list-style: none; padding: 0; max-height: min(55vh, 480px); overflow-y: auto; }
.recent-files-row { display: flex; align-items: center; gap: 4px; }
.recent-file-open { flex: 1; min-width: 0; padding: 9px 10px; text-align: left; border: 0; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
.recent-file-open:hover { background: var(--app-hover); }
.recent-file-open.is-selected { background: var(--app-selected); color: var(--app-onSelected); }
.recent-file-open:disabled { opacity: 0.6; }
.recent-file-name, .recent-file-path { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recent-file-name { font-size: 0.875rem; }
.recent-file-path { font-size: 0.75rem; margin-top: 3px; }
</style>
