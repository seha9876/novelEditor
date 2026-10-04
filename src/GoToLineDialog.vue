<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { parseLineNumber } from './editorNavigation'

const props = defineProps<{
  modelValue: boolean
  currentLine: number
  lineCount: number
  disabled: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  navigate: [line: number]
  closed: []
}>()
const value = ref('')
const targetLine = computed(() => parseLineNumber(value.value, props.lineCount))
const error = computed(() => targetLine.value === null ? `1～${props.lineCount}の整数を入力してください` : '')

watch(() => props.modelValue, (open) => {
  if (open) value.value = String(props.currentLine)
})

/** 有効な行番号だけを本文へ渡す。実際の文書範囲は移動時にも再確認する。 */
function navigate(): void {
  if (props.disabled || targetLine.value === null) return
  emit('navigate', targetLine.value)
  emit('update:modelValue', false)
}

/** IME変換の確定Enterでは移動せず、通常のEnterだけを処理する。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  navigate()
}

/** 開いた時点の現在行を選択し、番号をそのまま入力し直せるようにする。 */
function selectInput(event: FocusEvent): void {
  if (event.target instanceof HTMLInputElement) event.target.select()
}
</script>

<template>
  <VDialog :model-value="modelValue" max-width="420" aria-labelledby="go-to-line-title" @update:model-value="emit('update:modelValue', $event)" @after-leave="emit('closed')">
    <VCard>
      <VCardTitle id="go-to-line-title">行へ移動</VCardTitle>
      <VCardText>
        <p class="mb-4">全{{ lineCount }}行（画面上の折り返しは数えません）</p>
        <VTextField
          v-model="value"
          autofocus
          label="行番号"
          inputmode="numeric"
          variant="outlined"
          density="compact"
          :disabled="disabled"
          :error-messages="error"
          @focus="selectInput"
          @keydown="onKeydown"
        />
      </VCardText>
      <VCardActions>
        <VSpacer />
        <VBtn variant="text" @click="emit('update:modelValue', false)">キャンセル</VBtn>
        <VBtn color="primary" variant="text" :disabled="disabled || targetLine === null" @click="navigate">移動</VBtn>
      </VCardActions>
    </VCard>
  </VDialog>
</template>
