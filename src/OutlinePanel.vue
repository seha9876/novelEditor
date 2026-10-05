<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { runSidebarAnalysis } from './sidebarWorker'
import { cloneOutlineRules, outlineRulesSignature, type OutlineHeading, type OutlineRuleSet } from './outline'
import type { DocumentEditorHandle } from './useDocumentSession'
const props = defineProps<{ active: boolean; editor: DocumentEditorHandle | null; revision: number; head: number; documentKey: string | null; preferences: OutlineRuleSet; disabled: boolean }>()
const emit = defineEmits<{ settings: [] }>()
const headings = ref<OutlineHeading[]>([]), collapsed = ref<string[]>([]), error = ref(''), pending = ref(false), stale = ref(true), focused = ref(0)
const list = ref<HTMLElement | null>(null)
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined, abort: AbortController | null = null, parsedRevision = -1
const keys = computed(() => {
  const occurrences = new Map<string, number>()
  return headings.value.map(heading => {
    const key = `${heading.ruleId}/${heading.text}`, count = occurrences.get(key) ?? 0
    occurrences.set(key, count + 1)
    return `${key}/${count}`
  })
})
const parents = computed(() => new Set(headings.value.flatMap(heading => heading.parent === null ? [] : [heading.parent])))
const visible = computed(() => headings.value.map((heading, index) => ({ ...heading, index })).filter(heading => {
  let parent = heading.parent
  while (parent !== null) { if (collapsed.value.includes(keys.value[parent]!)) return false; parent = headings.value[parent]!.parent }
  return true
}))
const current = computed(() => { let index = -1; for (let i = 0; i < headings.value.length; i++) { if (headings.value[i]!.from <= props.head) index = i; else break }; return index })

/** 非表示や本文変更で旧解析を止め、古い見出し位置への移動を無効にする。 */
function cancel(): void { generation++; abort?.abort(); abort = null; if (timer) clearTimeout(timer); timer = undefined; pending.value = false; stale.value = true }
/** 本文が落ち着いてから抽出し、現在の本文・ルールと一致する結果だけを表示する。 */
function schedule(): void {
  cancel()
  if (!props.active) return
  timer = setTimeout(() => { void analyze() }, 200)
}
/** 設定画面と同じ抽出器を使い、失敗と見出し0件を区別する。 */
async function analyze(): Promise<void> {
  const snapshot = props.editor?.getDocumentSnapshot()
  if (!snapshot) return
  const own = generation, controller = new AbortController(); abort = controller; pending.value = true; error.value = ''
  try {
    const parsed = await runSidebarAnalysis<OutlineHeading[]>({ kind: 'outline', text: snapshot.text, preferences: { rules: cloneOutlineRules(props.preferences) } }, controller.signal)
    if (own !== generation || snapshot.revision !== props.editor?.getDocumentSnapshot().revision) return
    headings.value = parsed; parsedRevision = snapshot.revision; stale.value = false
    if (!visible.value.some(item => item.index === focused.value)) focused.value = visible.value[0]?.index ?? 0
  } catch (reason) { if (own === generation) error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { if (own === generation) pending.value = false }
}
/** 見出しを選んだときだけ本文へ移動し、抽出によって本文や編集履歴を変更しない。 */
function navigate(index: number): void {
  const heading = headings.value[index]
  if (!heading || !props.active || props.disabled || stale.value || pending.value) return
  if (!props.editor?.revealRange({ revision: parsedRevision, from: heading.from, to: heading.from })) { stale.value = true; schedule() }
}
/** 存在する親子階層だけを折りたたみ、本文の現在位置は変えない。 */
function toggle(index: number): void {
  const key = keys.value[index]!
  collapsed.value = collapsed.value.includes(key) ? collapsed.value.filter(item => item !== key) : [...collapsed.value, key]
}
/** 表示行の移動・親子の開閉をツリーと同じキーで行い、Enterで本文へ移る。 */
async function onKey(event: KeyboardEvent, index: number): Promise<void> {
  if (event.isComposing) return
  const rows = visible.value, position = rows.findIndex(item => item.index === index)
  let target = index
  if (event.key === 'ArrowDown') target = rows[Math.min(rows.length - 1, position + 1)]?.index ?? index
  else if (event.key === 'ArrowUp') target = rows[Math.max(0, position - 1)]?.index ?? index
  else if (event.key === 'Home') target = rows[0]?.index ?? index
  else if (event.key === 'End') target = rows[rows.length - 1]?.index ?? index
  else if (event.key === 'ArrowRight') { if (collapsed.value.includes(keys.value[index]!)) toggle(index); else target = headings.value.findIndex(item => item.parent === index); if (target < 0) target = index }
  else if (event.key === 'ArrowLeft') { if (parents.value.has(index) && !collapsed.value.includes(keys.value[index]!)) toggle(index); else target = headings.value[index]?.parent ?? index }
  else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(index); return }
  else return
  event.preventDefault(); focused.value = target; await nextTick(); list.value?.querySelector<HTMLButtonElement>(`[data-outline-index="${target}"]`)?.focus()
}
/** 空の階層レベルを挿入せず、表示上の親の深さだけ字下げする。 */
function depth(index: number): number { let value = 0, parent = headings.value[index]?.parent ?? null; while (parent !== null) { value++; parent = headings.value[parent]!.parent } return value }
// プリセット名や一覧の変更では、同じ本文・ルールを再解析しない。
watch([() => props.revision, () => props.active, () => outlineRulesSignature(props.preferences)], schedule, { immediate: true })
watch(() => props.documentKey, () => { headings.value = []; collapsed.value = []; focused.value = 0 })
onBeforeUnmount(cancel)
</script>
<template>
  <div class="sidebar-inner">
    <div class="sidebar-options"><p class="sidebar-help">現在の本文の見出し。未保存の編集も含みます。</p><VBtn size="small" variant="text" @click="emit('settings')">判定ルール</VBtn></div>
    <p v-if="pending || stale && !error" role="status">見出しを確認しています…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="!pending && !stale && !headings.length"><p>見出しが見つかりません。</p><p class="sidebar-help">「第一章 再会」などを認識します。本文の書式は変えず、判定ルールを追加できます。</p><VBtn variant="tonal" size="small" @click="emit('settings')">見出しの判定を設定</VBtn></div>
    <div ref="list" role="tree" aria-label="現在の本文のアウトライン">
      <div v-for="heading in visible" :key="keys[heading.index]" class="outline-row" :style="{ paddingInlineStart: `${depth(heading.index) * 12}px` }">
        <button v-if="parents.has(heading.index)" class="outline-expander" tabindex="-1" :aria-label="`${heading.text}を${collapsed.includes(keys[heading.index]!) ? '展開' : '折りたたむ'}`" @click="toggle(heading.index)">{{ collapsed.includes(keys[heading.index]!) ? '▸' : '▾' }}</button><span v-else class="outline-expander" />
        <button class="sidebar-result" role="treeitem" :data-outline-index="heading.index" :tabindex="focused === heading.index ? 0 : -1" :aria-level="depth(heading.index) + 1" :aria-current="current === heading.index ? 'location' : undefined" :aria-expanded="parents.has(heading.index) ? !collapsed.includes(keys[heading.index]!) : undefined" :disabled="disabled || stale || pending" @focus="focused = heading.index" @keydown="onKey($event, heading.index)" @click="navigate(heading.index)">{{ heading.text }}<small>{{ heading.line }}行</small></button>
      </div>
    </div>
  </div>
</template>
