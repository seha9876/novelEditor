<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { isHexColor, type ColorKey } from './appearance'
import { colorTargets } from './appearanceTargets'

const props = defineProps<{ colorKey: ColorKey; label: string; value: string; baseline: string; epoch: number }>()
const emit = defineEmits<{
  change: [key: ColorKey, value: string, interactionId: string]; finish: []
  targetHover: [key: ColorKey, active: boolean]; targetFocus: [key: ColorKey, active: boolean]
}>()
const draft = ref(props.value)
const editing = ref(false)
const error = computed(() => isHexColor(draft.value) ? '' : '#RRGGBB の6桁で入力してください。')
let interactionId: string | undefined

watch(() => props.value, (value) => { if (!editing.value) draft.value = value })
watch(() => props.epoch, () => { interactionId = undefined; editing.value = false; draft.value = props.value })

/** フォーカスから確定までを同じUndo操作として識別する。 */
function begin(): void {
  interactionId ??= crypto.randomUUID()
  editing.value = true
}

/** 入力途中の文字列は手元に残し、有効な色だけを即時反映する。 */
function inputHex(value: string): void {
  draft.value = value
  if (isHexColor(value)) change(value)
}

/** ピッカーの連続入力を同じ操作IDでメイン窓へ送る。 */
function change(value: string): void {
  interactionId ??= crypto.randomUUID()
  draft.value = value.toUpperCase()
  emit('change', props.colorKey, draft.value, interactionId)
}

/** テキスト入力の完了時は有効値だけを大文字へ揃える。 */
function finish(): void {
  editing.value = false
  if (interactionId) emit('finish')
  interactionId = undefined
  if (isHexColor(draft.value)) draft.value = draft.value.toUpperCase()
}

/** 選択中のプリセットの色へ、この項目だけ戻す。 */
function restore(): void {
  begin()
  draft.value = props.baseline
  change(props.baseline)
  finish()
}

/** 行内のピッカー・HEX入力・復元ボタン間の移動では強調を解除しない。 */
function leaveFocus(event: FocusEvent): void {
  if (event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget)) return
  emit('targetFocus', props.colorKey, false)
}
</script>

<template>
  <div class="color-setting-row" @pointerenter="emit('targetHover', colorKey, true)" @pointerleave="emit('targetHover', colorKey, false)" @focusin="emit('targetFocus', colorKey, true)" @focusout="leaveFocus">
    <div class="color-setting-caption">
      <label :for="`color-${colorKey}`" class="color-setting-label">{{ label }}</label>
      <p :id="`color-help-${colorKey}`" class="color-setting-description">{{ colorTargets[colorKey].description }}</p>
    </div>
    <input
      :id="`color-${colorKey}`" type="color" :value="isHexColor(draft) ? draft : value" :aria-label="`${label}のカラーピッカー`" :aria-describedby="`color-help-${colorKey}`"
      @focus="begin" @pointerdown="begin" @input="change(($event.target as HTMLInputElement).value)" @change="finish" @blur="finish"
    >
    <VTextField
      :model-value="draft" :aria-label="`${label}のHEX値`" :aria-describedby="`color-help-${colorKey}`" density="compact" variant="outlined"
      :error-messages="error" hide-details="auto" spellcheck="false" maxlength="7" class="color-hex-input"
      @focus="editing = true; begin()" @blur="finish" @update:model-value="inputHex"
    />
    <VBtn icon="mdi-restore" variant="text" size="small" :aria-label="`${label}をプリセットの色に戻す`" :title="`${label}をプリセットの色に戻す`" :disabled="value === baseline && !error" @click="restore" />
  </div>
</template>
