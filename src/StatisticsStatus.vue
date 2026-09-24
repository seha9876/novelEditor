<script setup lang="ts">
import type { EditorStatistics } from './editorStatistics'
import type { TextCounts } from './textStatistics'

defineProps<{ statistics: EditorStatistics }>()

/** 未確定値を0と誤認させず、確定値だけを桁区切りで表示する。 */
function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('ja-JP')
}

/** 原稿用紙の組版枚数ではなく、通常文字数による400字換算を表示する。 */
function formatPages(counts: TextCounts | null): string {
  return counts ? (counts.characters / 400).toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '—'
}
</script>

<template>
  <div class="statistics-status">
    <div class="statistics-inline">
      <span v-if="statistics.error" class="statistics-warning">統計エラー</span>
      <span class="statistics-total">全文 {{ formatNumber(statistics.document?.characters) }} 文字</span>
      <span v-if="statistics.selectionRanges" class="statistics-selection">選択 {{ formatNumber(statistics.selection?.characters) }} 文字</span>
      <span class="statistics-position">{{ formatNumber(statistics.line) }} 行 {{ formatNumber(statistics.column) }} 列</span>
      <VMenu location="top end" :close-on-content-click="false">
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
    </div>
  </div>
</template>
