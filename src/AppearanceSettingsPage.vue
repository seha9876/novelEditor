<script setup lang="ts">
import { computed, ref } from 'vue'
import SettingExpansionSection from './SettingExpansionSection.vue'
import ColorSettingInput from './ColorSettingInput.vue'
import { builtInPresets, colorDefinitions, colorKeys, findColorPreset, isAppearanceModified, presetNameError, type AppearancePreferences, type ColorKey } from './appearance'
import type { SettingsCommand } from './settingsSession'
import type { SettingsSectionDefinition, SettingsSectionId } from './settingsDefinitions'

const props = defineProps<{
  appearance: AppearancePreferences
  epoch: number
  fileBusy: boolean
  headingLevel: number
  sections: readonly SettingsSectionDefinition[]
  expandedSectionIds: readonly SettingsSectionId[]
}>()
const emit = defineEmits<{
  command: [command: SettingsCommand]
  toggleSection: [sectionId: SettingsSectionId, expanded: boolean]
  flushColors: []
}>()
const presets = computed(() => [...builtInPresets, ...props.appearance.presets])
const baseline = computed(() => findColorPreset(props.appearance) ?? builtInPresets[0])
const modified = computed(() => isAppearanceModified(props.appearance))
const userPreset = computed(() => props.appearance.presets.find((preset) => preset.id === props.appearance.basePresetId))
const groups = [...new Set(colorKeys.map((key) => colorDefinitions[key][0]))]
const colorGroups = groups.map((label) => ({ label, keys: colorKeys.filter((key) => colorDefinitions[key][0] === label) }))
const pendingSwitch = ref<string | null>(null)
const dialog = ref<'switch' | 'name' | 'delete' | null>(null)
const dialogOpen = computed({ get: () => dialog.value !== null, set: (open: boolean) => { if (!open) dialog.value = null } })
const nameMode = ref<'save' | 'rename' | 'switch'>('save')
const presetName = ref('')
const nameError = computed(() => presetNameError(props.appearance, presetName.value, nameMode.value === 'rename' ? userPreset.value?.id : undefined))

/** 色入力を既存の設定コマンドへ変換する。 */
function changeColor(key: ColorKey, value: string, interactionId: string): void {
  emit('command', { type: 'appearance', action: { type: 'color', key, value, interactionId } })
}

/** 未保存の調整がある場合だけ、切替前に保存方法を選んでもらう。 */
function choosePreset(id: string | null): void {
  if (!id) return
  pendingSwitch.value = id
  if (modified.value) dialog.value = 'switch'
  else switchPreset(false)
}

/** 保存・破棄の選択を1回の設定更新として送信する。 */
function switchPreset(save: boolean): void {
  if (!pendingSwitch.value) return
  if (save && !userPreset.value) { openNameDialog('switch'); return }
  emit('command', { type: 'appearance', action: { type: 'switch', id: pendingSwitch.value, ...(save ? { save: {} } : {}) } })
  pendingSwitch.value = null
  dialog.value = null
}

/** 新規保存・名前変更・保存して切替の共通入力欄を開く。 */
function openNameDialog(mode: 'save' | 'rename' | 'switch'): void {
  nameMode.value = mode
  presetName.value = mode === 'rename' ? userPreset.value?.name ?? '' : ''
  dialog.value = 'name'
}

/** 入力名が有効な場合だけ登録し、標準プリセットには上書きしない。 */
function confirmName(): void {
  if (nameError.value) return
  const name = presetName.value.trim()
  if (nameMode.value === 'rename' && userPreset.value) {
    emit('command', { type: 'appearance', action: { type: 'rename', id: userPreset.value.id, name } })
  } else if (nameMode.value === 'switch' && pendingSwitch.value) {
    emit('command', { type: 'appearance', action: { type: 'switch', id: pendingSwitch.value, save: { id: crypto.randomUUID(), name } } })
    pendingSwitch.value = null
  } else {
    emit('command', { type: 'appearance', action: { type: 'save', id: crypto.randomUUID(), name } })
  }
  dialog.value = null
}

/** 使用中の登録を削除しても、現在の配色はそのまま維持する。 */
function confirmDelete(): void {
  if (userPreset.value) emit('command', { type: 'appearance', action: { type: 'delete', id: userPreset.value.id } })
  dialog.value = null
}
</script>

<template>
  <SettingExpansionSection
    v-for="section in sections" :key="section.id" :section="section" :heading-level="headingLevel"
    :expanded="expandedSectionIds.includes(section.id)" @update-expanded="emit('toggleSection', section.id, $event)"
  >
    <template #status><VChip v-if="modified" size="x-small" variant="tonal">変更あり</VChip></template>
    <div class="appearance-settings">
      <p class="appearance-help">変更はすべての画面に反映され、現在の配色として自動保存されます。プリセットへ残すには保存ボタンを使用してください。</p>
      <VSelect :model-value="appearance.basePresetId" :items="presets" item-title="name" item-value="id" label="配色プリセット" placeholder="名前を付けて保存していない配色" variant="outlined" density="compact" hide-details @update:model-value="choosePreset" />
      <div class="appearance-actions">
        <VBtn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-save-plus-outline" @click="openNameDialog('save')">名前を付けて保存</VBtn>
        <VBtn size="small" variant="text" :disabled="!userPreset || !modified" @click="emit('command', { type: 'appearance', action: { type: 'save' } })">上書き保存</VBtn>
        <VBtn size="small" variant="text" :disabled="!userPreset" @click="openNameDialog('rename')">名前変更</VBtn>
        <VBtn size="small" variant="text" :disabled="!userPreset" @click="dialog = 'delete'">削除</VBtn>
        <VBtn size="small" variant="text" prepend-icon="mdi-import" :disabled="fileBusy" @click="emit('command', { type: 'appearance-file', operation: 'import' })">インポート</VBtn>
        <VBtn size="small" variant="text" prepend-icon="mdi-export" :disabled="fileBusy || !appearance.basePresetId" @click="emit('command', { type: 'appearance-file', operation: 'export', presetId: appearance.basePresetId ?? undefined })">エクスポート</VBtn>
      </div>
      <p class="appearance-help">エクスポートは選択したプリセットの保存済みの色を書き出します。各色の「戻す」は基準プリセットの色へ戻します。</p>
      <VExpansionPanels multiple variant="accordion">
        <VExpansionPanel v-for="group in colorGroups" :key="group.label" :title="group.label">
          <VExpansionPanelText>
            <ColorSettingInput v-for="key in group.keys" :key="key" :color-key="key" :label="colorDefinitions[key][1]" :value="appearance.colors[key]" :baseline="baseline.colors[key]" :epoch="epoch" @change="changeColor" @finish="emit('flushColors')" />
          </VExpansionPanelText>
        </VExpansionPanel>
      </VExpansionPanels>
      <p class="appearance-help">OS標準のタイトルバーとファイル選択画面の色は変更されません。</p>
    </div>
  </SettingExpansionSection>
  <!-- 確認から名前入力へ同じダイアログ内で移り、閉じる処理と次の表示を競合させない。 -->
  <VDialog v-model="dialogOpen" max-width="520" @keydown.stop>
    <VCard v-if="dialog === 'switch'" title="調整中の配色を保存しますか？">
      <VCardText>プリセットに保存していない変更があります。</VCardText>
      <VCardActions class="appearance-actions">
        <VBtn @click="dialog = null; pendingSwitch = null">キャンセル</VBtn>
        <VBtn @click="switchPreset(false)">破棄して切替</VBtn>
        <VBtn color="primary" @click="switchPreset(true)">保存して切替</VBtn>
      </VCardActions>
    </VCard>
    <VCard v-else-if="dialog === 'name'" :title="nameMode === 'rename' ? 'プリセットの名前変更' : '名前を付けて保存'">
      <VCardText><VTextField v-model="presetName" label="プリセット名" variant="outlined" autofocus maxlength="80" :error-messages="presetName ? nameError : ''" @keydown.enter.prevent="confirmName" /></VCardText>
      <VCardActions><VSpacer /><VBtn @click="dialog = null">キャンセル</VBtn><VBtn color="primary" :disabled="!!nameError" @click="confirmName">保存</VBtn></VCardActions>
    </VCard>
    <VCard v-else-if="dialog === 'delete'" title="プリセットを削除しますか？">
      <VCardText>「{{ userPreset?.name }}」を一覧から削除します。現在の配色はそのまま残ります。</VCardText>
      <VCardActions><VSpacer /><VBtn @click="dialog = null">キャンセル</VBtn><VBtn color="error" @click="confirmDelete">削除</VBtn></VCardActions>
    </VCard>
  </VDialog>
</template>
