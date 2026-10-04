<script setup lang="ts">
import { computed, type CSSProperties } from 'vue'
import { colorDefinitions, type ColorKey, type Palette } from './appearance'
import { colorTargets, getColorPreviewParts, type ColorPreviewPart } from './appearanceTargets'
import { notificationTextColor } from './appearancePresentation'

const props = defineProps<{ colors: Palette; activeKey: ColorKey | null }>()
const parts = computed(() => getColorPreviewParts(props.activeKey))
const target = computed(() => props.activeKey ? colorTargets[props.activeKey] : null)
const title = computed(() => props.activeKey ? `${colorDefinitions[props.activeKey][0]} · ${colorDefinitions[props.activeKey][1]}` : '変更対象のプレビュー')

/** 見本だけに現在色を使い、通知の文字色も実画面と同じ明暗判定にする。 */
function sampleStyle(part: ColorPreviewPart): CSSProperties {
  const background = props.colors[part.background]
  const notification = ['error', 'warning', 'info'].includes(part.background)
  return { backgroundColor: background, color: notification ? notificationTextColor(background) : props.colors[part.text], borderColor: part.border ? props.colors[part.border] : 'transparent' }
}
</script>

<template>
  <aside class="appearance-preview" aria-label="配色の適用先の見本">
    <div class="appearance-preview-heading">
      <strong>{{ title }}</strong><span v-if="target" class="appearance-preview-kind">{{ target.kind }}</span>
    </div>
    <p class="appearance-preview-description" aria-live="polite">{{ target?.description ?? '色の行にマウスを合わせるか、入力欄へ移動すると、対象を枠で示します。' }}</p>
    <div class="appearance-preview-parts" aria-hidden="true">
      <div v-for="part in parts" :key="part.id" class="appearance-preview-part">
        <span class="appearance-preview-part-label">{{ part.label }}</span>
        <div class="appearance-preview-sample" :class="{ 'is-target': target?.sample === part.id }" :data-target-kind="target?.kind" :style="sampleStyle(part)"><span>{{ part.content }}</span></div>
      </div>
    </div>
    <p class="appearance-preview-note">見本には未表示の状態も含みます。実画面は表示中の代表箇所を強調します。</p>
  </aside>
</template>
