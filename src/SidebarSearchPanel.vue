<script setup lang="ts">
import { nextTick, ref } from 'vue'
import type { useSidebarSearch } from './useSidebarSearch'
import type { SearchConditions, SearchScopeStatus } from './searchSession'
const props = defineProps<{ controller: ReturnType<typeof useSidebarSearch>; conditions: SearchConditions; scopeStatus: SearchScopeStatus; projectName: string; disabled: boolean }>()
const emit = defineEmits<{ conditions: [patch: Partial<SearchConditions>]; clearScope: [] }>()
const c = props.controller
const list = ref<HTMLElement | null>(null)
/** 検索結果の選択と実行を分け、IME確定や入力欄の矢印移動を妨げない。 */
async function onResultsKey(event: KeyboardEvent): Promise<void> {
  if (event.isComposing) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); c.moveSelection(event.key === 'ArrowDown' ? 1 : -1); await nextTick(); list.value?.querySelector(`[data-result-index="${c.selected.value}"]`)?.scrollIntoView({ block: 'nearest' }) }
  else if (event.key === 'Enter') { event.preventDefault(); void c.openMatch(c.selected.value) }
}
</script>
<template>
  <div class="sidebar-search sidebar-inner" role="search" aria-label="本文の検索結果">
    <VSelect v-model="c.scope.value" :items="[{ title: '現在の本文', value: 'document' }, { title: '現在のプロジェクト', value: 'project' }]" label="検索対象" density="compact" :disabled="disabled || c.navigating.value" hide-details />
    <p v-if="c.scope.value === 'project'" class="sidebar-help">{{ projectName || 'プロジェクト未選択' }}に登録したTXTを検索します。未登録ファイルは対象外です。</p>
    <VTextField :model-value="conditions.search" label="検索する文字" density="compact" :disabled="disabled || c.navigating.value" hide-details @update:model-value="emit('conditions', { search: $event })" @keydown.enter="!$event.isComposing && c.search()" />
    <div class="sidebar-options">
      <VCheckbox :model-value="conditions.caseSensitive" label="大小文字を区別" density="compact" hide-details :disabled="disabled || c.navigating.value" @update:model-value="emit('conditions', { caseSensitive: !!$event })" />
      <VCheckbox :model-value="conditions.regexp" label="正規表現" density="compact" hide-details :disabled="disabled || c.navigating.value" @update:model-value="emit('conditions', { regexp: !!$event })" />
    </div>
    <div v-if="c.scope.value === 'document' && scopeStatus.enabled" class="sidebar-help">{{ scopeStatus.empty ? '検索範囲が空です' : `${scopeStatus.startLine}～${scopeStatus.endLine}行の指定範囲に限定` }}<VBtn variant="text" size="small" :disabled="disabled" @click="emit('clearScope')">限定を解除</VBtn></div>
    <VBtn v-if="c.scope.value === 'project'" :disabled="disabled || c.navigating.value || !conditions.search" size="small" variant="tonal" @click="c.pending.value ? c.cancel() : c.search()">{{ c.pending.value ? '中止' : '検索' }}</VBtn>
    <p role="status" aria-live="polite">{{ c.message.value }}</p>
    <p v-if="c.stale.value" class="sidebar-help">結果の位置が古くなっています。再検索してください。</p>
    <details v-if="c.errors.value.length"><summary>検索できなかった理由（{{ c.errors.value.length }}件）</summary><p v-for="error in c.errors.value" :key="error" class="sidebar-help">{{ error }}</p></details>
    <div ref="list" role="listbox" :aria-activedescendant="c.results.value.length ? `sidebar-match-${c.selected.value}` : undefined" aria-label="一致箇所" tabindex="0" class="sidebar-result-list" @keydown="onResultsKey">
      <button v-for="(match, index) in c.results.value.slice(0, c.shown.value)" :id="`sidebar-match-${index}`" :key="index" :data-result-index="index" tabindex="-1" class="sidebar-result" role="option" :aria-selected="index === c.selected.value" :disabled="disabled || c.stale.value || c.pending.value || c.navigating.value" @click="c.openMatch(index)">
        <strong>{{ match.candidate?.name || match.path?.split(/[\\/]/).pop() || '現在の本文' }} · {{ match.line }}行</strong>
        <small v-if="match.candidate">{{ match.candidate.folderPath || 'ルート' }} · {{ match.candidate.path }}</small>
        <small v-if="match.current">編集中の本文を検索</small>
        <span>{{ match.before }}<mark>{{ match.match || '空の一致' }}</mark>{{ match.after }}</span>
      </button>
    </div>
    <VBtn v-if="c.results.value.length > c.shown.value" variant="text" size="small" @click="c.shown.value += 200">さらに200件表示</VBtn>
  </div>
</template>
