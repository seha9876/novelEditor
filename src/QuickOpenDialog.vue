<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue'
import { projectFileSearchLimit, type ProjectFileSearchResult } from './projectFileSearch'

const props = defineProps<{
  modelValue: boolean
  query: string
  allProjects: boolean
  results: ProjectFileSearchResult
  selectedNodeId: number | null
  pending: boolean
  disabled: boolean
  error: string
  focusRevision: number
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'update:query': [value: string]
  'update:allProjects': [value: boolean]
  select: [nodeId: number]
  move: [direction: -1 | 1]
  openFile: [nodeId?: number]
  closed: []
}>()
const searchHost = ref<HTMLElement | null>(null)
const resultsHost = ref<HTMLElement | null>(null)
const id = useId()
const listId = `quick-open-list-${id}`

/** 表示後に検索欄へ移り、再度Ctrl+Pを押した場合にも入力を選択し直す。 */
async function focusQuery(): Promise<void> {
  await nextTick()
  if (!props.modelValue || props.pending) return
  const input = searchHost.value?.querySelector('input')
  input?.focus()
  input?.select()
}

/** 候補移動では入力フォーカスを維持し、選択行だけを一覧の表示範囲へ戻す。 */
async function revealSelection(): Promise<void> {
  await nextTick()
  if (!props.modelValue || props.selectedNodeId === null) return
  resultsHost.value?.querySelector<HTMLElement>(`[data-candidate-id="${props.selectedNodeId}"]`)?.scrollIntoView({ block: 'nearest' })
}

watch(() => props.focusRevision, () => { void focusQuery() })
watch(() => props.selectedNodeId, () => { void revealSelection() })

/** IME確定とボタン本来のEnter動作を妨げず、候補の上下移動・決定を処理する。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) {
    // Vuetifyの窓側へEscapeを渡さず、IMEの変換取消だけを行う。
    if (event.key === 'Escape') event.stopPropagation()
    return
  }
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
  if (props.pending || props.disabled) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    emit('move', event.key === 'ArrowDown' ? 1 : -1)
  } else if (event.key === 'Enter' && !(event.target instanceof Element && event.target.closest('button'))) {
    event.preventDefault()
    emit('openFile')
  }
}
</script>

<template>
  <VDialog :model-value="modelValue" :persistent="pending" max-width="680" :aria-labelledby="`quick-open-title-${id}`" @update:model-value="emit('update:modelValue', $event)" @after-enter="focusQuery" @after-leave="emit('closed')">
    <VCard @keydown="onKeydown">
      <VCardTitle :id="`quick-open-title-${id}`">プロジェクト内ファイルを開く</VCardTitle>
      <VCardText class="quick-open-content">
        <div ref="searchHost">
          <VTextField
            :model-value="query" label="ファイル名で検索" variant="outlined" density="compact" hide-details autofocus
            :disabled="pending || disabled" :spellcheck="false" autocomplete="off"
            role="combobox" aria-autocomplete="list" aria-expanded="true" :aria-controls="listId"
            :aria-activedescendant="selectedNodeId === null ? undefined : `${listId}-${selectedNodeId}`"
            @update:model-value="emit('update:query', $event ?? '')"
          />
        </div>
        <VCheckbox :model-value="allProjects" label="全プロジェクトを検索" density="compact" hide-details :disabled="pending || disabled" @update:model-value="emit('update:allProjects', $event === true)" />
        <p class="quick-open-summary" role="status" aria-live="polite">
          {{ results.total }}件の一致<span v-if="results.total > projectFileSearchLimit">（先頭{{ projectFileSearchLimit }}件を表示。検索語を追加して絞り込めます）</span>
        </p>
        <div :id="listId" ref="resultsHost" class="quick-open-results" role="listbox" aria-label="登録ファイルの検索結果" :aria-busy="pending">
          <button
            v-for="candidate in results.candidates" :id="`${listId}-${candidate.nodeId}`" :key="candidate.nodeId"
            class="quick-open-result" :class="{ 'is-selected': candidate.nodeId === selectedNodeId }"
            type="button" role="option" :aria-selected="candidate.nodeId === selectedNodeId" tabindex="-1"
            :data-candidate-id="candidate.nodeId" :disabled="pending || disabled" :title="candidate.path"
            @focus="emit('select', candidate.nodeId)" @click="emit('openFile', candidate.nodeId)"
          >
            <span class="quick-open-name">{{ candidate.name }}</span>
            <span class="quick-open-location">{{ candidate.projectName }} ／ {{ candidate.folderPath || 'ルート' }}</span>
            <span class="quick-open-path">{{ candidate.path }}</span>
          </button>
        </div>
        <p v-if="!results.total" class="quick-open-empty">一致する登録ファイルがありません。検索語や対象範囲を変更してください。</p>
        <p v-if="pending" role="status">ファイルを開いています…</p>
        <p v-if="error" class="text-error" role="alert">{{ error }}</p>
        <p class="quick-open-help">↑↓: 候補を選択 ／ Enter: 開く ／ Esc: キャンセル</p>
      </VCardText>
      <VCardActions>
        <VSpacer />
        <VBtn variant="text" :disabled="pending" @click="emit('update:modelValue', false)">キャンセル</VBtn>
        <VBtn color="primary" variant="text" :disabled="pending || disabled || selectedNodeId === null" @click="emit('openFile')">開く</VBtn>
      </VCardActions>
    </VCard>
  </VDialog>
</template>

<style scoped>
.quick-open-content { min-height: 0; }
.quick-open-summary, .quick-open-help, .quick-open-empty { margin-block: 8px; font-size: 0.8rem; color: rgba(var(--v-theme-on-surface), 0.7); }
.quick-open-results { max-height: min(360px, 40vh); overflow: auto; }
.quick-open-result { display: flex; flex-direction: column; width: 100%; gap: 2px; padding: 8px 12px; border: 0; border-radius: 4px; color: inherit; background: transparent; text-align: start; cursor: pointer; }
.quick-open-result:hover { background: rgba(var(--v-theme-on-surface), 0.04); }
.quick-open-result.is-selected { background: rgba(var(--v-theme-primary), 0.12); box-shadow: inset 3px 0 rgb(var(--v-theme-primary)); }
.quick-open-result:disabled { cursor: default; opacity: 0.6; }
.quick-open-name, .quick-open-location, .quick-open-path { max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.quick-open-name { font-weight: 500; }
.quick-open-location, .quick-open-path { font-size: 0.75rem; color: rgba(var(--v-theme-on-surface), 0.7); }
</style>
