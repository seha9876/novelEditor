<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getTypographyNumberOptions, isValidTypographyNumber, shouldCommitTypographyInput } from './editorSettings'

const props = defineProps<{
  modelValue: number
  field: 'fontSize' | 'lineHeight'
  label: string
  suffix?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: number]
}>()

const draft = ref(formatValue(props.modelValue))
const options = computed(() => {
  return getTypographyNumberOptions(props.field).map((value) => ({ title: formatValue(value), value }))
})

watch(() => props.modelValue, (value) => {
  draft.value = formatValue(value)
})

/** 表示形式を項目に合わせ、行間は小数第一位で統一する。 */
function formatValue(value: number): string {
  return props.field === 'lineHeight' ? value.toFixed(1) : String(value)
}

/** 入力中の文字列を保持し、Enterまたはフォーカス移動時に確定する。 */
function updateDraft(value: string | null): void {
  draft.value = value ?? ''
}

/** 候補から選んだ値を既存の入力検証と設定更新経路へ渡す。 */
function selectOption(value: number): void {
  if (!isValidTypographyNumber(props.field, value)) return
  draft.value = formatValue(value)
  emit('update:modelValue', value)
}

/** 文字サイズ・行間の共通制約を満たす入力だけ確定する。 */
function commitText(value = draft.value): void {
  const normalized = value.trim()
  const number = Number(normalized)
  if (/^\d+(?:\.\d+)?$/.test(normalized) && isValidTypographyNumber(props.field, number)) {
    draft.value = formatValue(number)
    emit('update:modelValue', number)
    return
  }
  draft.value = formatValue(props.modelValue)
}

/** IME変換確定のEnterは通し、通常のEnterだけ入力値を確定する。 */
function onKeydown(event: KeyboardEvent): void {
  if (!shouldCommitTypographyInput(event)) return
  event.stopPropagation()
  event.preventDefault()
  commitText()
}
</script>

<template>
  <div class="toolbar-typography-number" @focusout="commitText()">
    <VTextField
      class="toolbar-typography-number-field"
      :model-value="draft"
      :label="label"
      :suffix="suffix"
      :disabled="disabled"
      type="text"
      inputmode="decimal"
      density="compact"
      variant="outlined"
      hide-details
      @update:model-value="updateDraft"
      @keydown="onKeydown"
    />
    <VMenu location="bottom end" :close-on-content-click="true">
      <template #activator="{ props: menuProps }">
        <VBtn
          v-bind="menuProps"
          class="toolbar-typography-number-menu"
          icon="mdi-menu-down"
          size="small"
          variant="text"
          :disabled="disabled"
          :aria-label="`${label}の候補を表示`"
        />
      </template>
      <VList density="compact" max-height="280" :aria-label="`${label}の候補`">
        <VListItem
          v-for="option in options"
          :key="option.value"
          :title="option.title"
          :active="option.value === modelValue"
          active-color="primary"
          @click="selectOption(option.value)"
        />
      </VList>
    </VMenu>
  </div>
</template>
