<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { STANDARD_OUTLINE_PRESET_ID, type OutlinePreferences } from './outline'
import { findOutlinePreset, isOutlineModified, outlinePresetNameError, standardOutlinePreset } from './outlinePresets'
import { useOutlineRuleDraft } from './useOutlineRuleDraft'
import type { SettingsCommand } from './settingsSession'

const props = defineProps<{ preferences: OutlinePreferences; epoch: number; fileBusy: boolean }>()
const emit = defineEmits<{ command: [command: SettingsCommand]; dialogOpen: [open: boolean] }>()
const ruleDraft = useOutlineRuleDraft({ preferences: () => props.preferences, epoch: () => props.epoch,
  publish: (rules, epoch) => emit('command', { type: 'outline', action: { type: 'rules', rules }, epoch }) })
const { draft, example, preview, previewError, previewPending, savePending, errors } = ruleDraft
const presets = computed(() => [standardOutlinePreset, ...props.preferences.presets])
const modified = computed(() => isOutlineModified({ ...props.preferences, rules: draft.value.rules }))
const userPreset = computed(() => props.preferences.presets.find(preset => preset.id === props.preferences.basePresetId))
const selectedName = computed(() => findOutlinePreset(props.preferences)?.name ?? '現在の設定（未登録）')
const dialog = ref<'switch' | 'name' | 'delete' | null>(null)
const pendingSwitch = ref<string | null>(null)
const nameMode = ref<'save' | 'rename' | 'switch'>('save'), presetName = ref('')
const actionBusy = ref(false)
const locked = computed(() => actionBusy.value || props.fileBusy)
const nameError = computed(() => outlinePresetNameError(props.preferences, presetName.value, nameMode.value === 'rename' ? userPreset.value?.id : undefined))
const dialogOpen = computed({ get: () => dialog.value !== null, set: (open: boolean) => { if (!open) closeDialog() } })
watch(dialogOpen, open => emit('dialogOpen', open))
watch(() => props.epoch, () => { dialog.value = null; pendingSwitch.value = null })
onBeforeUnmount(() => { ruleDraft.dispose(); emit('dialogOpen', false) })
/** 有効な編集だけを既存設定履歴へ送り、入力途中は画面内の下書きに留める。 */
function change(): void { ruleDraft.change() }
/** 既存書式に合わせる独自ルールを追加し、未完成の値は保存しない。 */
function addRule(): void { draft.value.rules.unshift({ id: crypto.randomUUID(), name: '独自の見出し', enabled: true, level: 2, kind: 'affix', prefix: '', suffix: '', pattern: '' }); change() }
/** ルールの優先順位を移し、一行から複数の見出しを生成しない。 */
function move(index: number, direction: number): void { const rule = draft.value.rules.splice(index, 1)[0]!; draft.value.rules.splice(index + direction, 0, rule); change() }
/** 標準も含むルールを削除し、空の一覧でも本文は変更しない。 */
function remove(index: number): void { draft.value.rules.splice(index, 1); change() }
/** 変更した下書きがある場合は、保存方法を選んでから切り替える。 */
function choosePreset(id: string | null): void {
  if (!id || locked.value) return
  pendingSwitch.value = id
  if (modified.value) dialog.value = 'switch'
  else void switchPreset(false)
}

/** 標準への復帰も同じ確認を通し、保存済み登録は削除しない。 */
function reset(): void { choosePreset(STANDARD_OUTLINE_PRESET_ID) }

/** 取消時は進行中の保存用判定を止め、通常の下書き確認へ戻す。 */
function closeDialog(): void { dialog.value = null; pendingSwitch.value = null; ruleDraft.schedule() }

/** 保存する場合だけWorker判定を待ち、切替と保存を一つのコマンドで送る。 */
async function switchPreset(save: boolean): Promise<void> {
  if (!pendingSwitch.value || locked.value) return
  if (save && !userPreset.value) { openNameDialog('switch'); return }
  const id = pendingSwitch.value, epoch = props.epoch
  actionBusy.value = true
  try {
    const rules = save ? await ruleDraft.validate() : undefined
    if (save && !rules) return
    if (epoch !== props.epoch) return
    ruleDraft.cancel()
    emit('command', { type: 'outline', epoch, action: { type: 'switch', id, ...(rules ? { save: { rules } } : {}) } })
    pendingSwitch.value = null; dialog.value = null
  } finally { actionBusy.value = false }
}

/** 名前入力は配色と同じ操作に揃え、標準には上書きしない。 */
function openNameDialog(mode: 'save' | 'rename' | 'switch'): void {
  nameMode.value = mode; presetName.value = mode === 'rename' ? userPreset.value?.name ?? '' : ''; dialog.value = 'name'
}

/** 最新の下書きを検証して上書きし、保留編集を別の保存値で置き換えない。 */
async function overwrite(): Promise<void> {
  if (!userPreset.value || locked.value) return
  const epoch = props.epoch
  actionBusy.value = true
  try {
    const rules = await ruleDraft.validate()
    if (!rules || epoch !== props.epoch) return
    ruleDraft.markSubmitted(rules)
    emit('command', { type: 'outline', epoch, action: { type: 'save', rules } })
  } finally { actionBusy.value = false }
}

/** 名前変更は下書きに触れず、新規保存・保存して切替だけ判定完了を待つ。 */
async function confirmName(): Promise<void> {
  if (nameError.value || locked.value) return
  const epoch = props.epoch, name = presetName.value.trim(), target = pendingSwitch.value
  if (nameMode.value === 'rename' && userPreset.value) {
    emit('command', { type: 'outline', epoch, action: { type: 'rename', id: userPreset.value.id, name } }); dialog.value = null; return
  }
  actionBusy.value = true
  try {
    const rules = await ruleDraft.validate()
    if (!rules || epoch !== props.epoch) return
    const id = crypto.randomUUID()
    if (nameMode.value === 'switch' && target) {
      emit('command', { type: 'outline', epoch, action: { type: 'switch', id: target, save: { id, name, rules } } })
    } else {
      ruleDraft.markSubmitted(rules)
      emit('command', { type: 'outline', epoch, action: { type: 'save', id, name, rules } })
    }
    pendingSwitch.value = null; dialog.value = null
  } finally { actionBusy.value = false }
}

/** 現在のルールは維持したまま、確認されたユーザー登録だけを削除する。 */
function confirmDelete(): void {
  if (!userPreset.value || locked.value) return
  emit('command', { type: 'outline', epoch: props.epoch, action: { type: 'delete', id: userPreset.value.id } }); dialog.value = null
}
</script>
<template>
  <section aria-label="アウトラインの見出し判定">
    <h2>アウトライン</h2>
    <p>すべての原稿で使う判定ルールです。本文に独自の記法を挿入することはありません。一行に複数のルールが合う場合は、上のルールを使います。</p>
    <p class="setting-help">有効な編集は判定確認後に自動反映・保存されます。プリセットへ残すには保存ボタンを使用してください。</p>
    <div class="d-flex align-center ga-2 my-3 flex-wrap">
      <VSelect :model-value="preferences.basePresetId" :items="presets" item-title="name" item-value="id" label="アウトラインプリセット" placeholder="現在の設定（未登録）" variant="outlined" density="compact" hide-details :disabled="locked" class="outline-preset-select" @update:model-value="choosePreset" />
      <VChip v-if="modified" size="small" variant="tonal">変更あり</VChip>
    </div>
    <p v-if="!preferences.basePresetId" class="setting-help">{{ selectedName }}</p>
    <div class="d-flex ga-1 mb-3 flex-wrap">
      <VBtn size="small" variant="tonal" color="primary" :disabled="locked" @click="openNameDialog('save')">名前を付けて保存</VBtn>
      <VBtn size="small" variant="text" :disabled="locked || !userPreset || !modified" @click="overwrite">上書き保存</VBtn>
      <VBtn size="small" variant="text" :disabled="locked || !userPreset" @click="openNameDialog('rename')">名前変更</VBtn>
      <VBtn size="small" variant="text" :disabled="locked || !userPreset" @click="dialog = 'delete'">削除</VBtn>
      <VBtn size="small" variant="text" :disabled="locked" @click="emit('command', { type: 'outline-file', operation: 'import' })">インポート</VBtn>
      <VBtn size="small" variant="text" :disabled="locked || !preferences.basePresetId" @click="emit('command', { type: 'outline-file', operation: 'export', presetId: preferences.basePresetId ?? undefined })">エクスポート</VBtn>
    </div>
    <p class="setting-help">エクスポートは選択したプリセットの保存済み内容を書き出します。標準のルールも削除でき、「標準に戻す」で復帰できます。</p>
    <p v-if="savePending" role="status">{{ errors.some(Boolean) || previewError ? 'この入力はまだ保存していません。判定の理由を確認してください。' : '判定を確認中です。完了後に自動保存します。' }}</p>
    <div class="d-flex ga-2 my-3 flex-wrap"><VBtn variant="tonal" :disabled="locked" @click="addRule">ルールを追加</VBtn><VBtn variant="text" :disabled="locked" @click="reset">標準に戻す</VBtn></div>
    <p v-if="!draft.rules.length" role="status">ルールがありません。ルールを追加するか、プリセットを選んでください。</p>
    <VCard v-for="(rule, index) in draft.rules" :key="rule.id" variant="outlined" class="pa-3 mb-3">
      <div class="d-flex align-center ga-2 flex-wrap">
        <VCheckbox v-model="rule.enabled" :label="rule.kind === 'standard' ? `標準: ${rule.name}` : 'このルールを使う'" :disabled="locked" hide-details @update:model-value="change" />
        <VBtn icon="mdi-arrow-up" size="small" variant="text" aria-label="優先順位を上げる" :disabled="locked || index === 0" @click="move(index, -1)" />
        <VBtn icon="mdi-arrow-down" size="small" variant="text" aria-label="優先順位を下げる" :disabled="locked || index === draft.rules.length - 1" @click="move(index, 1)" />
        <VBtn icon="mdi-delete-outline" size="small" variant="text" :aria-label="`${rule.name}のルールを削除`" :disabled="locked" @click="remove(index)" />
      </div>
      <VTextField v-if="rule.kind !== 'standard'" v-model="rule.name" label="ルールの名前" :disabled="locked" @update:model-value="change" />
      <VSelect v-model="rule.level" :items="[1,2,3,4,5,6]" label="見出しレベル（小さいほど上位）" :disabled="locked" @update:model-value="change" />
      <template v-if="rule.kind !== 'standard'">
        <VSelect v-model="rule.kind" :items="[{title:'行頭・行末の文字',value:'affix'},{title:'番号を含む形式',value:'numbered'},{title:'正規表現（詳細設定）',value:'regexp'}]" label="判定方法" :disabled="locked" @update:model-value="change" />
        <template v-if="rule.kind === 'affix'"><VTextField v-model="rule.prefix" label="行頭の文字（例: ◆）" :disabled="locked" @update:model-value="change" /><VTextField v-model="rule.suffix" label="行末の文字（省略可）" :disabled="locked" @update:model-value="change" /></template>
        <VTextField v-else v-model="rule.pattern" :label="rule.kind === 'numbered' ? '番号を含む形式（例: 第{番号}話）' : '一行ごとに判定する正規表現'" :disabled="locked" @update:model-value="change" />
      </template>
      <p v-if="errors[index]" role="status" class="text-error">{{ errors[index] }} この入力はまだ保存していません。</p>
    </VCard>
    <h3>判定を試す</h3><p>前後の空白を除いた一行ごとに判定します。</p>
    <VTextarea v-model="example" label="見出しと本文の例" rows="4" :disabled="locked" />
    <p role="status">{{ previewPending ? '判定中…' : previewError || `${preview.length}件の見出し` }}</p>
    <ul><li v-for="heading in preview" :key="heading.from">{{ heading.line }}行 · レベル{{ heading.level }} · {{ heading.text }}</li></ul>
  </section>
  <VDialog v-model="dialogOpen" max-width="520" @keydown.stop>
    <VCard v-if="dialog === 'switch'" title="調整中のアウトライン設定を保存しますか？">
      <VCardText>プリセットに保存していない変更があります。<p v-if="previewError" role="alert" class="text-error">{{ previewError }}</p></VCardText>
      <VCardActions class="flex-wrap">
        <VBtn @click="closeDialog">キャンセル</VBtn><VBtn :disabled="locked" @click="switchPreset(false)">破棄して切替</VBtn><VBtn color="primary" :loading="actionBusy" :disabled="locked" @click="switchPreset(true)">保存して切替</VBtn>
      </VCardActions>
    </VCard>
    <VCard v-else-if="dialog === 'name'" :title="nameMode === 'rename' ? 'プリセットの名前変更' : '名前を付けて保存'">
      <VCardText><VTextField v-model="presetName" label="プリセット名" variant="outlined" autofocus maxlength="80" :disabled="locked" :error-messages="presetName ? nameError : ''" @keydown.enter.prevent="confirmName" /><p v-if="previewError && nameMode !== 'rename'" role="alert" class="text-error">{{ previewError }}</p></VCardText>
      <VCardActions><VSpacer /><VBtn @click="closeDialog">キャンセル</VBtn><VBtn color="primary" :disabled="locked || !!nameError" :loading="actionBusy" @click="confirmName">保存</VBtn></VCardActions>
    </VCard>
    <VCard v-else-if="dialog === 'delete'" title="プリセットを削除しますか？">
      <VCardText>「{{ userPreset?.name }}」を一覧から削除します。現在のルールはそのまま残ります。</VCardText>
      <VCardActions><VSpacer /><VBtn @click="closeDialog">キャンセル</VBtn><VBtn color="error" :disabled="locked" @click="confirmDelete">削除</VBtn></VCardActions>
    </VCard>
  </VDialog>
</template>

<style scoped>
.outline-preset-select { flex: 1 1 240px; min-width: 0; }
</style>
