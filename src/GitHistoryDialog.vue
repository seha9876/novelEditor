<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { useGitHistoryController } from './useGitHistoryController'
const props = defineProps<{ controller: ReturnType<typeof useGitHistoryController> }>()
const emit = defineEmits<{ closed: [] }>()
const c = props.controller
const changeLabels = { added: '追加', modified: '変更', deleted: '削除' }
const panel = ref<{ $el: HTMLElement } | null>(null)
let previousFocus: HTMLElement | null = null
watch(c.pending, (pending) => {
  if (pending) {
    if (document.activeElement instanceof HTMLElement && panel.value?.$el.contains(document.activeElement)) previousFocus = document.activeElement
  } else { void restoreOperationFocus() }
}, { flush: 'sync' })

/** ボタンの無効化より前のフォーカス位置を記憶し、完了後の復帰先にする。 */
function rememberFocus(event: FocusEvent): void {
  if (!c.pending.value && event.target instanceof HTMLElement) previousFocus = event.target
}

/** 一時無効化で失ったキーボード位置を戻す。別ダイアログや利用者の移動は奪わない。 */
async function restoreOperationFocus(): Promise<void> {
  await nextTick()
  if (!previousFocus || !c.isOpen.value || c.pending.value || c.restoreSource.value || c.savePrompt.value) return
  if (document.activeElement !== document.body && document.activeElement !== previousFocus) return
  const target = previousFocus.isConnected ? previousFocus : panel.value?.$el.querySelector<HTMLElement>('[data-git-refresh]')
  target?.focus({ preventScroll: true })
  previousFocus = null
}

/** Gitの日付を利用者の環境で読みやすく表示し、解釈できない値は原文を残す。 */
function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP')
}
</script>

<template>
  <VDialog :model-value="c.isOpen.value" :persistent="c.pending.value || c.savePrompt.value || !!c.restoreSource.value" max-width="1080" scrollable aria-label="履歴とバックアップ" @update:model-value="c.close" @after-leave="emit('closed')">
    <VCard ref="panel" class="git-history" @focusin="rememberFocus">
      <VCardTitle>履歴とバックアップ</VCardTitle>
      <VCardSubtitle>保存 → 履歴を記録 → 別ドライブへバックアップ</VCardSubtitle>
      <VProgressLinear v-if="c.pending.value" indeterminate aria-label="Git の処理中" />
      <VCardText>
        <VAlert v-if="c.error.value" type="error" variant="tonal" class="mb-3 git-message" role="alert">{{ c.error.value }}</VAlert>
        <VAlert v-if="c.notice.value" type="success" variant="tonal" class="mb-3 git-message" role="status">{{ c.notice.value }}</VAlert>
        <p v-if="!c.version.value" class="mb-3">Git for Windows が必要です。インストールしてアプリを再起動してください。原稿の編集・通常保存はそのまま使えます。</p>
        <div class="git-actions">
          <VBtn :disabled="c.pending.value || !c.version.value" prepend-icon="mdi-folder-plus-outline" @click="c.add">管理フォルダーを追加</VBtn>
          <VBtn :disabled="c.pending.value || !c.version.value" variant="tonal" @click="c.beginRestore">バックアップから復元</VBtn>
          <VBtn data-git-refresh :disabled="c.pending.value" variant="text" @click="c.refresh">更新</VBtn>
        </div>
        <VSelect :model-value="c.selectedId.value" :items="c.workspaces.value" item-title="root" item-value="id" label="管理フォルダー" :disabled="c.pending.value" hide-details class="my-4" @update:model-value="c.select" />
        <div v-if="c.workspace.value" class="git-actions mb-3">
          <span class="git-path">{{ c.workspace.value.root }}</span>
          <VBtn :disabled="c.pending.value" variant="text" size="small" @click="c.remove">一覧から登録を解除</VBtn>
        </div>
        <template v-if="c.status.value">
          <div class="git-state" role="status">
            <span>ブランチ: {{ c.status.value.branch || '未選択' }}</span>
            <span>{{ c.unsaved.value ? '未保存の本文があります' : '対象フォルダー内の編集中原稿に未保存変更なし' }}</span>
            <span>保存済みの未記録TXT: {{ c.status.value.changes.length }}件</span>
            <span>{{ c.status.value.backupState }}</span>
          </div>
          <VAlert v-if="c.status.value.blocked" type="warning" variant="tonal" class="my-3">{{ c.status.value.blocked }}</VAlert>
          <div class="git-columns">
            <section aria-label="履歴を記録">
              <h2>1. 履歴を記録</h2>
              <p class="git-help">保存済みのTXTだけを記録します。原稿の内容は書き換えません。</p>
              <div class="git-change-list" aria-label="記録するTXT">
                <VCheckbox v-for="change in c.status.value.changes" :key="change.path" v-model="c.selectedPaths.value" :value="change.path" :label="`${changeLabels[change.kind]}: ${change.path}`" :disabled="c.pending.value || !!c.status.value.blocked" hide-details density="compact" />
                <p v-if="!c.status.value.changes.length" class="pa-3">記録するTXTの変更はありません。</p>
              </div>
              <VTextField v-model="c.description.value" label="記録の説明（省略可）" placeholder="例: 第1章の会話を推敲" :disabled="c.pending.value" class="mt-3" hide-details />
              <template v-if="!c.status.value.authorName || !c.status.value.authorEmail">
                <p class="git-help mt-3">Gitに未設定の記録者情報を補います。ほかのGit設定は変更しません。</p>
                <VTextField v-if="!c.status.value.authorName" v-model="c.authorName.value" label="記録者の名前" :disabled="c.pending.value" hide-details class="mt-2" />
                <VTextField v-if="!c.status.value.authorEmail" v-model="c.authorEmail.value" label="メール（省略可）" :disabled="c.pending.value" hide-details class="mt-2" />
              </template>
              <VBtn color="primary" class="mt-3" :disabled="c.pending.value || !!c.status.value.blocked || !c.selectedPaths.value.length || !(c.status.value.authorName || c.authorName.value.trim())" @click="c.beginRecord">履歴を記録</VBtn>
            </section>
            <section aria-label="バックアップ">
              <h2>2. バックアップ</h2>
              <p class="git-help">現在のブランチとその過去の記録を送ります。記録済みの画像等も含まれます。他ブランチ・タグ・未記録の変更・アプリ設定は含みません。</p>
              <p class="git-path my-3">{{ c.workspace.value?.backup || 'バックアップ先は未設定です' }}</p>
              <div class="git-actions">
                <VBtn :disabled="c.pending.value" variant="tonal" @click="c.setBackup">保存先を選ぶ</VBtn>
                <VBtn color="primary" :disabled="c.pending.value || !c.workspace.value?.backup || !c.status.value.head || !c.status.value.branch" @click="c.backup">バックアップ</VBtn>
              </div>
              <p class="git-help mt-3">別ドライブの空フォルダーを指定できます。未接続でも原稿とローカルの履歴は残ります。</p>
            </section>
          </div>
          <VDivider class="my-5" />
          <section aria-label="過去の原稿を確認">
            <h2>履歴を見る・取り出す</h2>
            <p class="git-help">記録を選び、その時点のTXTを確認します。新しい名前で取り出すため、現在の原稿は変わりません。</p>
            <div class="git-columns mt-3">
              <div>
                <div class="git-entry-list" aria-label="記録一覧">
                  <button v-for="entry in c.entries.value" :key="entry.id" type="button" class="git-entry" :class="{ selected: c.selectedCommit.value === entry.id }" :disabled="c.pending.value" :aria-pressed="c.selectedCommit.value === entry.id" @click="c.selectCommit(entry.id)">
                    <strong>{{ entry.message || '説明なし' }}</strong>
                    <span>{{ formatDate(entry.date) }} · {{ entry.author }}</span>
                  </button>
                  <p v-if="!c.entries.value.length">まだ履歴がありません。</p>
                </div>
                <VBtn v-if="c.hasMore.value" :disabled="c.pending.value" variant="text" @click="c.more">次の50件</VBtn>
              </div>
              <div>
                <VSelect :model-value="c.selectedFile.value" :items="c.files.value" label="記録時点のTXT" :disabled="c.pending.value || !c.selectedCommit.value" hide-details @update:model-value="c.selectFile" />
                <p v-if="c.selectedCommit.value && !c.files.value.length" class="git-help mt-2">この記録に対象のTXTはありません。</p>
                <VAlert v-if="c.previewError.value" type="warning" variant="tonal" class="my-2">{{ c.previewError.value }}</VAlert>
                <pre v-if="c.selectedFile.value && !c.previewError.value" class="git-preview" tabindex="0" aria-label="過去の本文（読み取り専用）">{{ c.preview.value }}</pre>
                <VBtn :disabled="c.pending.value || !c.selectedFile.value" class="mt-3" variant="tonal" @click="c.exportFile">新しい名前で取り出す</VBtn>
              </div>
            </div>
          </section>
        </template>
      </VCardText>
      <VCardActions><span class="git-help">{{ c.version.value }}</span><VSpacer /><VBtn :disabled="c.pending.value" @click="c.close">閉じる</VBtn></VCardActions>
    </VCard>
  </VDialog>
  <VDialog :model-value="c.savePrompt.value" max-width="540" aria-label="未保存の本文" @update:model-value="c.record('cancel')" @after-leave="restoreOperationFocus">
    <VCard title="未保存の本文があります">
      <VCardText>履歴にはディスクへ保存済みの内容を記録します。「保存して続ける」では、保存後に変更一覧を再確認できます。</VCardText>
      <VCardActions class="git-actions"><VBtn @click="c.record('save')">保存して続ける</VBtn><VBtn @click="c.record('disk')">保存済みの内容だけ記録</VBtn><VBtn @click="c.record('cancel')">キャンセル</VBtn></VCardActions>
    </VCard>
  </VDialog>
  <VDialog :model-value="!!c.restoreSource.value" :persistent="c.pending.value" max-width="600" aria-label="バックアップから復元" @update:model-value="c.restoreSource.value = ''" @after-leave="restoreOperationFocus">
    <VCard title="バックアップから復元">
      <VCardText>
        <p class="git-path mb-3">{{ c.restoreSource.value }}</p>
        <VAlert v-if="c.error.value" type="error" variant="tonal" class="mb-3 git-message">{{ c.error.value }}</VAlert>
        <VSelect v-model="c.restoreBranch.value" :items="c.restoreBranches.value" label="復元するブランチ" :disabled="c.pending.value" />
        <VTextField v-model="c.restoreName.value" label="新しいフォルダー名" :disabled="c.pending.value" />
        <p>次に復元先の親フォルダーを選びます。既存のフォルダーは上書きしません。</p>
      </VCardText>
      <VCardActions><VBtn :disabled="c.pending.value" @click="c.restoreSource.value = ''">キャンセル</VBtn><VBtn :disabled="c.pending.value || !c.restoreName.value.trim()" color="primary" @click="c.restore">復元先を選んで復元</VBtn></VCardActions>
    </VCard>
  </VDialog>
</template>

<style scoped>
.git-history h2 { font-size: 1rem; margin-bottom: 8px; }
.git-help { font-size: .8125rem; color: var(--app-muted); }
.git-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.git-path, .git-message { overflow-wrap: anywhere; white-space: pre-wrap; }
.git-state { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 12px; background: var(--app-surface); border: 1px solid var(--app-border); margin-bottom: 16px; }
.git-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.git-columns > * { min-width: 0; }
.git-change-list, .git-entry-list { max-height: 240px; overflow: auto; }
.git-change-list { border: 1px solid var(--app-border); }
.git-entry { display: block; text-align: left; width: 100%; padding: 10px; color: inherit; border: 0; border-radius: 4px; background: transparent; overflow-wrap: anywhere; cursor: pointer; }
.git-entry span { display: block; color: var(--app-muted); font-size: .75rem; margin-top: 4px; }
.git-entry:hover { background: var(--app-hover); }
.git-entry.selected { background: var(--app-selected); color: var(--app-onSelected); }
.git-entry:focus-visible, .git-preview:focus-visible { outline: 2px solid var(--app-focus); outline-offset: -2px; }
.git-entry:disabled { opacity: .6; }
.git-preview { margin-top: 12px; padding: 12px; max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; background: var(--app-editorBackground); color: var(--app-editorText); border: 1px solid var(--app-border); }
@media (max-width: 750px) { .git-columns { grid-template-columns: 1fr; } }
</style>
