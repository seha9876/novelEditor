<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { cloneOutline, createDefaultOutline, outlineRuleError, type OutlineHeading, type OutlinePreferences } from './outline'
import { runSidebarAnalysis } from './sidebarWorker'
const props = defineProps<{ preferences: OutlinePreferences }>()
const emit = defineEmits<{ change: [preferences: OutlinePreferences] }>()
const draft = ref(cloneOutline(props.preferences)), example = ref('第一章 再会\n本文です。\n第一節 翌朝'), preview = ref<OutlineHeading[]>([]), previewError = ref(''), previewPending = ref(false)
const errors = computed(() => draft.value.rules.map(outlineRuleError))
const savePending = ref(false)
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined, abort: AbortController | null = null
/** 同じ保存値の再配信で未完成の入力を消さず、Undoや保存失敗による変更は反映する。 */
watch(() => props.preferences, (next, previous) => { if (JSON.stringify(next) !== JSON.stringify(previous)) { savePending.value = false; draft.value = cloneOutline(next); schedulePreview() } }, { deep: true })
/** 有効な編集だけを既存設定履歴へ送り、入力途中は画面内の下書きに留める。 */
function change(): void { schedulePreview(true) }
/** 既存書式に合わせる独自ルールを追加し、未完成の値は保存しない。 */
function addRule(): void { draft.value.rules.unshift({ id: crypto.randomUUID(), name: '独自の見出し', enabled: true, level: 2, kind: 'affix', prefix: '', suffix: '', pattern: '' }); schedulePreview() }
/** ルールの優先順位を移し、一行から複数の見出しを生成しない。 */
function move(index: number, direction: number): void { const rule = draft.value.rules.splice(index, 1)[0]!; draft.value.rules.splice(index + direction, 0, rule); change() }
/** 作成したルールを一覧から削除し、本文は変更しない。 */
function remove(index: number): void { draft.value.rules.splice(index, 1); change() }
/** 見出し設定だけを標準へ戻し、設定のUndoで戻せるよう一度の変更として送る。 */
function reset(): void { draft.value = createDefaultOutline(); change() }
/** 入力中の解析を停止し、プレビューでも長い正規表現をUIスレッドで実行しない。 */
function schedulePreview(saveDraft = false): void {
  if (saveDraft) savePending.value = true
  generation++; abort?.abort(); previewPending.value = false; if (timer) clearTimeout(timer)
  const own = generation
  timer = setTimeout(async () => {
    previewError.value = ''; preview.value = []
    if (errors.value.some(Boolean)) { previewError.value = 'ルールの入力を完成させてください。'; return }
    const controller = new AbortController(); abort = controller; previewPending.value = true
    try {
      const result = await runSidebarAnalysis<OutlineHeading[]>({
        kind: 'outline', text: example.value.replace(/\r\n|\r/g, '\n'), preferences: cloneOutline(draft.value),
      }, controller.signal)
      if (own !== generation) return
      preview.value = result
      if (savePending.value) {
        savePending.value = false
        emit('change', cloneOutline(draft.value))
      }
    }
    catch (reason) { if (own === generation) previewError.value = reason instanceof Error ? reason.message : String(reason) }
    finally { if (own === generation) previewPending.value = false }
  }, 200)
}
watch(example, () => schedulePreview(), { immediate: true })
onBeforeUnmount(() => { generation++; abort?.abort(); if (timer) clearTimeout(timer) })
</script>
<template>
  <section aria-label="アウトラインの見出し判定">
    <h2>アウトライン</h2>
    <p>すべての原稿で使う判定ルールです。本文に独自の記法を挿入することはありません。一行に複数のルールが合う場合は、上のルールを使います。</p>
    <p v-if="savePending" role="status">{{ errors.some(Boolean) || previewError ? 'この入力はまだ保存していません。判定の理由を確認してください。' : '判定を確認中です。完了後に自動保存します。' }}</p>
    <div class="d-flex ga-2 my-3"><VBtn variant="tonal" @click="addRule">ルールを追加</VBtn><VBtn variant="text" @click="reset">標準に戻す</VBtn></div>
    <VCard v-for="(rule, index) in draft.rules" :key="rule.id" variant="outlined" class="pa-3 mb-3">
      <div class="d-flex align-center ga-2 flex-wrap">
        <VCheckbox v-model="rule.enabled" :label="rule.kind === 'standard' ? `標準: ${rule.name}` : 'このルールを使う'" hide-details @update:model-value="change" />
        <VBtn icon="mdi-arrow-up" size="small" variant="text" aria-label="優先順位を上げる" :disabled="index === 0" @click="move(index, -1)" />
        <VBtn icon="mdi-arrow-down" size="small" variant="text" aria-label="優先順位を下げる" :disabled="index === draft.rules.length - 1" @click="move(index, 1)" />
        <VBtn v-if="rule.kind !== 'standard'" icon="mdi-delete-outline" size="small" variant="text" aria-label="ルールを削除" @click="remove(index)" />
      </div>
      <VTextField v-if="rule.kind !== 'standard'" v-model="rule.name" label="ルールの名前" @update:model-value="change" />
      <VSelect v-model="rule.level" :items="[1,2,3,4,5,6]" label="見出しレベル（小さいほど上位）" @update:model-value="change" />
      <template v-if="rule.kind !== 'standard'">
        <VSelect v-model="rule.kind" :items="[{title:'行頭・行末の文字',value:'affix'},{title:'番号を含む形式',value:'numbered'},{title:'正規表現（詳細設定）',value:'regexp'}]" label="判定方法" @update:model-value="change" />
        <template v-if="rule.kind === 'affix'"><VTextField v-model="rule.prefix" label="行頭の文字（例: ◆）" @update:model-value="change" /><VTextField v-model="rule.suffix" label="行末の文字（省略可）" @update:model-value="change" /></template>
        <VTextField v-else v-model="rule.pattern" :label="rule.kind === 'numbered' ? '番号を含む形式（例: 第{番号}話）' : '一行ごとに判定する正規表現'" @update:model-value="change" />
      </template>
      <p v-if="errors[index]" role="status" class="text-error">{{ errors[index] }} この入力はまだ保存していません。</p>
    </VCard>
    <h3>判定を試す</h3><p>前後の空白を除いた一行ごとに判定します。</p>
    <VTextarea v-model="example" label="見出しと本文の例" rows="4" />
    <p role="status">{{ previewPending ? '判定中…' : previewError || `${preview.length}件の見出し` }}</p>
    <ul><li v-for="heading in preview" :key="heading.from">{{ heading.line }}行 · レベル{{ heading.level }} · {{ heading.text }}</li></ul>
  </section>
</template>
