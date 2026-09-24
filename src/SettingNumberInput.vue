<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'

const props = defineProps<{
  modelValue: number
  inputText: string
  label: string
  min: number
  max: number
  step: number
  precision: number
  minFractionDigits?: number
  errorMessages?: string[]
  ariaDescribedby?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: number]
  inputText: [value: string]
  commit: []
  interaction: [value: number]
}>()

const root = ref<{ $el: HTMLElement } | null>(null)
let restoreTextOnFocus: string | null = null
let isRestoringInputText = false

/** Vuetifyコンポーネントのルート要素を取得する。 */
function getInputRoot(): HTMLElement | null {
  const element = root.value?.$el
  return element instanceof HTMLElement ? element : null
}

/** 値更新後の入力文字列を親へ渡し、空欄や範囲外の状態を表示する。 */
function readInputText(): string | null {
  return getInputRoot()?.querySelector('input')?.value ?? null
}

/** 親が保持する編集中の文字列を、Vuetify内部の入力状態にも復元する。 */
function restoreInputText(value: string): void {
  const input = getInputRoot()?.querySelector('input')
  if (!input || input.value === value) return

  isRestoringInputText = true
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  isRestoringInputText = false
}

/** 入力値が指定範囲と表示精度に収まるかを確認する。 */
function isValidInputText(value: string): boolean {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return false
  const number = Number(value)
  if (!Number.isFinite(number) || number < props.min || number > props.max) return false
  const scale = 10 ** props.precision
  return Math.abs(number * scale - Math.round(number * scale)) < 1e-9
}

/** Vuetify入力の文字列編集を検知し、エラー表示用の文字列を親へ通知する。 */
function onInput(event: Event): void {
  const target = event.target
  if (target instanceof HTMLInputElement) {
    if (!isRestoringInputText) restoreTextOnFocus = null
    emit('inputText', target.value)
  }
}

/** マウント時に保持中の入力文字列を表示し、フォーカス時の正規化でも維持する。 */
async function restoreDraftOnMount(): Promise<void> {
  await nextTick()
  if (readInputText() === props.inputText) return
  if (props.errorMessages?.length) restoreTextOnFocus = props.inputText
  restoreInputText(props.inputText)
}

/** Vuetifyのフォーカス時整形が保持中のエラー入力を消さないよう復元する。 */
async function onFocus(): Promise<void> {
  const value = restoreTextOnFocus
  if (value === null || !props.errorMessages?.length) return
  await nextTick()
  if (document.activeElement === getInputRoot()?.querySelector('input')) restoreInputText(value)
}

/** Vuetifyがblur時に行う範囲補正の完了後、確定処理を親へ通知する。 */
async function onFocusout(event: FocusEvent): Promise<void> {
  const target = event.target
  const inputRoot = getInputRoot()
  if (!(target instanceof HTMLInputElement) || !inputRoot) return

  await nextTick()
  if (!inputRoot.contains(target)) return
  emit('inputText', target.value)
  emit('commit')
}

/** 増減ボタンによる値の確定を検知し、親の入力途中状態を解除する。 */
async function onChange(event: Event): Promise<void> {
  if (event.isTrusted) return
  await nextTick()
  const inputText = readInputText()
  if (inputText === null || !isValidInputText(inputText)) return
  emit('inputText', inputText)
  emit('interaction', Number(inputText))
}

/** 有効な入力だけを親へ渡し、Vuetify内部の制御値と設定値をそろえる。 */
async function onModelValue(value: number | null): Promise<void> {
  const input = getInputRoot()?.querySelector('input') ?? null
  const inputTextAtUpdate = input?.value ?? null
  const inputWasFocused = input !== null && document.activeElement === input
  await nextTick()
  const inputText = readInputText()
  if (value === null) {
    if (inputText !== null) emit('inputText', inputText)
    return
  }
  if (!isValidInputText(String(value))) return

  if (inputWasFocused) {
    const typedText = inputText ?? inputTextAtUpdate
    if (typedText === null || !isValidInputText(typedText) || Number(typedText) !== value) return
    emit('inputText', typedText)
  } else {
    const normalizedText = inputText !== null && isValidInputText(inputText) && Number(inputText) === value
      ? inputText
      : String(value)
    emit('inputText', normalizedText)
  }
  emit('update:modelValue', value)
}

/** フォーカス中の入力欄上で、範囲内の値だけをホイールで一段階ずつ変える。 */
function onWheel(event: WheelEvent): void {
  const inputRoot = getInputRoot()
  const input = inputRoot?.querySelector('input')
  if (!inputRoot || !input || document.activeElement !== input || event.deltaY === 0) return

  const current = Number(input.value)
  if (!isValidInputText(input.value)) return

  const scale = 10 ** props.precision
  const direction = event.deltaY < 0 ? 1 : -1
  const stepped = Math.round((current + direction * props.step) * scale) / scale
  const next = Math.min(props.max, Math.max(props.min, stepped))
  if (next === current) return

  event.preventDefault()
  emit('inputText', String(next))
  emit('update:modelValue', next)
  emit('interaction', next)
}

onMounted(() => {
  void restoreDraftOnMount()
})
</script>

<template>
  <VNumberInput
    ref="root"
    :model-value="modelValue"
    :label="label"
    :min="min"
    :max="max"
    :step="step"
    :precision="precision"
    :min-fraction-digits="minFractionDigits"
    :error-messages="errorMessages"
    :aria-describedby="ariaDescribedby"
    :grouping="false"
    @focus="onFocus"
    @update:model-value="onModelValue"
    @input="onInput"
    @focusout="onFocusout"
    @change="onChange"
    @wheel="onWheel"
  />
</template>
