<script setup lang="ts">
import type { EditorSettings } from './editorSettings'
import type { StatusBarItemId } from './appPreferenceSchema'
import type { EditorStatistics } from './statisticsCalculation'
import type { TextCounts } from './textStatistics'

defineProps<{
  statistics: EditorStatistics
  items: readonly StatusBarItemId[]
  editorSettings: EditorSettings
}>()

/** 未確定値を0と誤認させず、確定値だけを桁区切りで表示する。 */
function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('ja-JP')
}

/** 原稿用紙の組版枚数ではなく、通常文字数による400字換算を表示する。 */
function formatPages(counts: TextCounts | null): string {
  return counts ? (counts.characters / 400).toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '—'
}

/** 折り返し設定をステータスバー向けの短い表示へ変換する。 */
function formatWrapMode(settings: EditorSettings): string {
  if (settings.wrapMode === 'window') return '画面幅'
  if (settings.wrapMode === 'columns') return `${settings.wrapColumns}桁`
  return '折り返しなし'
}
</script>

<template>
  <div class="statistics-status">
    <div class="statistics-inline">
      <span v-if="statistics.error" class="statistics-warning" role="alert" :title="statistics.error" :aria-label="`統計エラー: ${statistics.error}`">統計エラー</span>
      <template v-for="item in items" :key="item">
        <span v-if="item === 'documentCharacters'" class="statistics-status-item statistics-total" title="全文の文字数">全文 {{ formatNumber(statistics.document?.characters) }} 文字</span>
        <span v-else-if="item === 'selectionCharacters' && statistics.selectionRanges" class="statistics-status-item statistics-selection" title="選択範囲の文字数">選択 {{ formatNumber(statistics.selection?.characters) }} 文字</span>
        <span v-else-if="item === 'position'" class="statistics-status-item statistics-position" title="主カーソルの現在位置">{{ formatNumber(statistics.line) }} 行 {{ formatNumber(statistics.column) }} 列</span>
        <span v-else-if="item === 'lineCount'" class="statistics-status-item statistics-line-count" title="論理行数">全 {{ formatNumber(statistics.lineCount) }} 行</span>
        <span v-else-if="item === 'fontFamily'" class="statistics-status-item statistics-font-family" :title="editorSettings.fontFamily">{{ editorSettings.fontFamily }}</span>
        <span v-else-if="item === 'fontSize'" class="statistics-status-item statistics-font-size" title="本文の文字サイズ">{{ editorSettings.fontSize }}px</span>
        <span v-else-if="item === 'lineHeight'" class="statistics-status-item statistics-line-height" title="本文の行間">行間 {{ editorSettings.lineHeight }}</span>
        <span v-else-if="item === 'wrapMode'" class="statistics-status-item statistics-wrap-mode" title="本文の折り返し方式">{{ formatWrapMode(editorSettings) }}</span>
        <VMenu v-else-if="item === 'statistics'" location="top end" :close-on-content-click="false">
          <template #activator="{ props }">
            <VBtn v-bind="props" class="statistics-button" size="small" variant="text" prepend-icon="mdi-chart-box-outline" aria-label="執筆統計を表示">統計</VBtn>
          </template>
          <VCard class="statistics-card" title="執筆統計" width="420" max-width="calc(100vw - 24px)">
            <VCardText>
              <p v-if="statistics.error" class="statistics-error" role="alert">{{ statistics.error }}</p>
              <table class="statistics-table">
                <thead><tr><th scope="col">項目</th><th scope="col">全文</th><th scope="col">選択</th></tr></thead>
                <tbody>
                  <tr><th scope="row">文字数</th><td>{{ formatNumber(statistics.document?.characters) }}</td><td>{{ formatNumber(statistics.selection?.characters) }}</td></tr>
                  <tr><th scope="row">空白除外</th><td>{{ formatNumber(statistics.document?.withoutWhitespace) }}</td><td>{{ formatNumber(statistics.selection?.withoutWhitespace) }}</td></tr>
                  <tr><th scope="row">400字換算</th><td>{{ formatPages(statistics.document) }} 枚</td><td>{{ formatPages(statistics.selection) }} 枚</td></tr>
                </tbody>
              </table>
              <p class="statistics-details">論理行数 {{ formatNumber(statistics.lineCount) }} ／ 選択範囲 {{ formatNumber(statistics.selectionRanges) }}<br>現在位置 {{ formatNumber(statistics.line) }} 行 {{ formatNumber(statistics.column) }} 列</p>
              <p class="statistics-help">見た目の文字に近い書記素単位で、改行を除いて数えます。空白除外では空白・タブ等も除きます。複数の選択範囲は個別に数えて合算します。</p>
              <p class="statistics-help">400字換算は文字数による目安です。改行や空きマスを含む原稿用紙の組版枚数、投稿先の文字数規則とは異なります。</p>
            </VCardText>
          </VCard>
        </VMenu>
      </template>
    </div>
  </div>
</template>
