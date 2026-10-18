<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { previewSearchHistory, type SearchHistoryAction, type SearchHistoryEntry, type SearchHistoryState } from './searchHistory'
import type { SearchConditions } from './searchSession'

const props = defineProps<{ state: SearchHistoryState; disabled: boolean }>()
const emit = defineEmits<{ select: [conditions: SearchConditions]; mutate: [action: SearchHistoryAction] }>()
const open = ref(false), confirmClear = ref(false)
const content = ref<HTMLElement | null>(null)

/** 履歴の選択は条件の復元だけを通知し、描画後の入力フォーカスは呼出側へ委ねる。 */
async function select(entry: SearchHistoryEntry): Promise<void> {
  if (props.disabled) return
  open.value = false
  await nextTick()
  emit('select', { ...entry.conditions })
}

/** 確認済みの全消去だけを通知する。本文や現在の検索入力は消さない。 */
function clear(): void {
  if (props.disabled || props.state.busy) return
  confirmClear.value = false
  emit('mutate', { type: 'clear' })
}

/** 一覧内でキー操作を完結させ、検索窓のEnter・Escape処理へ伝播させない。 */
function onKey(event: KeyboardEvent): void {
  event.stopPropagation()
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (confirmClear.value) confirmClear.value = false
    else open.value = false
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const buttons = Array.from(content.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
      : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
    buttons[next]?.focus()
  }
}

/** 開いた直後はボタンにフォーカスが残るため、Escapeと矢印を一覧側と同じ規則で処理する。 */
function onActivatorKey(event: KeyboardEvent): void {
  if (open.value) onKey(event)
}
</script>

<template>
  <div class="search-history">
    <VMenu v-model="open" :close-on-content-click="false" max-width="520" max-height="360" @update:model-value="confirmClear = false">
      <template #activator="{ props: activator }">
        <VBtn v-bind="activator" prepend-icon="mdi-history" size="small" variant="text" :disabled="disabled" @keydown="onActivatorKey">履歴</VBtn>
      </template>
      <VCard>
        <div ref="content" class="history-content" role="group" aria-label="検索・置換の履歴" @keydown="onKey">
          <p v-if="state.busy" role="status">履歴を更新しています…</p>
          <p v-if="!state.entries.length">検索履歴はありません。</p>
          <div v-for="entry in state.entries" :key="entry.id" class="history-row">
            <button class="history-condition" :disabled="disabled" @click="select(entry)">
              <span>検索: {{ previewSearchHistory(entry.conditions.search) }}</span>
              <span>置換: {{ previewSearchHistory(entry.conditions.replace) }}</span>
              <small>{{ entry.conditions.caseSensitive ? '大小文字を区別' : '大小文字を区別しない' }} · {{ entry.conditions.regexp ? '正規表現' : '通常検索' }}</small>
            </button>
            <VBtn icon="mdi-close" size="x-small" variant="text" :disabled="disabled || state.busy" :aria-label="`履歴を削除: ${previewSearchHistory(entry.conditions.search)}`" @click="emit('mutate', { type: 'remove', id: entry.id })" />
          </div>
          <template v-if="confirmClear">
            <p>保存した検索履歴をすべて削除しますか？</p>
            <VBtn size="small" variant="text" @click="confirmClear = false">キャンセル</VBtn>
            <VBtn size="small" color="error" :disabled="disabled || state.busy" @click="clear">すべて削除</VBtn>
          </template>
          <VBtn v-else size="small" variant="text" :disabled="disabled || state.busy || !state.entries.length" @click="confirmClear = true">履歴をすべて削除…</VBtn>
        </div>
      </VCard>
    </VMenu>
    <p v-if="state.error" class="text-error history-error" role="alert">{{ state.error }}</p>
  </div>
</template>

<style scoped>
.history-content { padding: 12px; max-width: min(520px, calc(100vw - 24px)); font-size: 13px; }
.history-row { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid rgba(var(--v-theme-on-surface), .12); }
.history-condition { flex: 1; min-width: 0; padding: 8px; text-align: left; color: inherit; }
.history-condition span, .history-condition small { display: block; white-space: pre-wrap; overflow-wrap: anywhere; }
.history-condition:hover, .history-condition:focus-visible { background: rgba(var(--v-theme-primary), .12); }
.history-condition:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: -2px; }
.history-error { font-size: 12px; overflow-wrap: anywhere; }
</style>
