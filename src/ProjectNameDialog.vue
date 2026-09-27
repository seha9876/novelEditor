<!-- プロジェクトの作成・名称変更で共有する入力ダイアログ。 -->
<script setup lang="ts">
const props = defineProps<{
  modelValue: boolean
  title: string
  value: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'update:value': [value: string]
  save: []
}>()

/** 入力値を親のProjectActionsへ反映する。 */
function updateValue(value: string): void {
  emit('update:value', value)
}

/** Enter入力を保存操作として親へ渡す。 */
function saveOnEnter(): void {
  if (!props.disabled && props.value.trim()) emit('save')
}
</script>

<template>
  <VDialog :model-value="props.modelValue" max-width="420" @update:model-value="emit('update:modelValue', $event)">
    <VCard>
      <VCardTitle>{{ props.title }}</VCardTitle>
      <VCardText>
        <VTextField
          :model-value="props.value"
          autofocus
          label="名前"
          density="compact"
          variant="outlined"
          hide-details
          @update:model-value="updateValue"
          @keydown.enter.prevent="saveOnEnter"
        />
      </VCardText>
      <VCardActions>
        <VSpacer />
        <VBtn variant="text" @click="emit('update:modelValue', false)">キャンセル</VBtn>
        <VBtn color="primary" variant="text" :disabled="props.disabled || !props.value.trim()" @click="emit('save')">保存</VBtn>
      </VCardActions>
    </VCard>
  </VDialog>
</template>
