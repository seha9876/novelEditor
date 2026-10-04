<script setup lang="ts">
import type { useSidebarHistory } from './useSidebarHistory'
import { formatGitDate } from './gitHistoryPresentation'
import GitOperationFeedback from './GitOperationFeedback.vue'
defineProps<{ controller: ReturnType<typeof useSidebarHistory>; path: string | null; disabled: boolean }>()
const emit = defineEmits<{ manage: [root?: string] }>()
</script>
<template>
  <div class="sidebar-inner">
    <p class="sidebar-path">{{ path || '無題' }}</p>
    <p class="sidebar-help">現在の保存場所・ファイル名の履歴です。見るだけでは本文は変わりません。</p>
    <div class="sidebar-options"><VBtn variant="text" size="small" :disabled="disabled || controller.pending.value || controller.exporting.value" @click="controller.refresh">再確認</VBtn><VBtn variant="tonal" size="small" :disabled="disabled || controller.pending.value || controller.exporting.value" @click="emit('manage', controller.workspace.value?.root)">履歴とバックアップを開く</VBtn></div>
    <p v-if="controller.workspace.value" class="sidebar-help sidebar-path">管理フォルダー: {{ controller.workspace.value.root }}</p>
    <p v-if="controller.pending.value || controller.exporting.value" role="status">{{ controller.exporting.value ? '取り出し中…' : '履歴を読み込み中…' }}</p>
    <p v-else-if="controller.message.value" role="status">{{ controller.message.value }}</p>
    <GitOperationFeedback v-if="controller.feedback.value" :feedback="controller.feedback.value" />
    <p v-if="controller.notice.value" role="status" class="sidebar-path">{{ controller.notice.value }}</p>
    <button v-for="entry in controller.entries.value" :key="entry.id" class="sidebar-result" :aria-pressed="controller.selected.value?.id === entry.id" :disabled="disabled || controller.pending.value || controller.exporting.value" @click="controller.select(entry)"><strong>{{ entry.message || 'メモなし' }}</strong><small>{{ formatGitDate(entry.date) }} · {{ entry.author }}</small><small v-if="!entry.path">削除された状態の記録</small></button>
    <VBtn v-if="controller.hasMore.value" variant="text" size="small" :disabled="disabled || controller.pending.value || controller.exporting.value" @click="controller.more">さらに50件表示</VBtn>
    <details v-if="controller.selected.value" class="sidebar-preview" open>
      <summary>選んだ記録の本文（読み取り専用）</summary>
      <p v-if="!controller.selected.value.path">この時点では原稿が削除されています。以前の記録を選んでください。</p>
      <p v-else-if="controller.previewError.value">{{ controller.previewError.value }}</p>
      <template v-else-if="controller.previewReady.value"><pre tabindex="0" aria-label="過去の原稿（読み取り専用）">{{ controller.preview.value }}</pre><p v-if="!controller.preview.value">この原稿の本文は空です。</p></template>
      <VBtn size="small" variant="tonal" :disabled="!controller.canExport.value" @click="controller.exportFile">別のファイルとして取り出す</VBtn><p class="sidebar-help">既存ファイルは上書きせず、編集中の本文も切り替えません。</p>
    </details>
    <details class="mt-3"><summary>詳しい情報</summary><p class="sidebar-help">ブランチ: {{ controller.branch.value || '未確認' }}<br>記録ID: {{ controller.selected.value?.id || '未選択' }}<br>現在の系列の履歴のみを表示します。名前変更前の追跡は行いません。</p></details>
  </div>
</template>
