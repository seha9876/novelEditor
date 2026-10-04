<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { useGitHistoryController } from './useGitHistoryController'
import { formatGitDate, type GitNextTarget } from './gitHistoryPresentation'
import GitOperationFeedback from './GitOperationFeedback.vue'
const props = defineProps<{ controller: ReturnType<typeof useGitHistoryController> }>()
const emit = defineEmits<{ closed: [] }>()
const c = props.controller
const changeLabels = { added: '追加', modified: '変更', deleted: '削除された状態を記録' }
const panel = ref<{ $el: HTMLElement } | null>(null)
const detailsOpen = ref(false)
const folderMenuOpen = ref(false)
const showRecordAction = computed(() => !!c.workspace.value && c.tab.value === 'record' && (!c.status.value || !!c.status.value.changes.length || !!c.status.value.blocked))
const footerReason = computed(() => {
  if (showRecordAction.value) return c.recordDisabledReason.value
  if (c.tab.value === 'backup' && c.workspace.value) return !c.workspace.value.backup ? c.locked.value ? '別の処理が完了するまでお待ちください。' : !c.status.value ? '状態を確認してから保存先を設定できます。' : '' : c.backupDisabledReason.value
  if (c.tab.value === 'history' && c.entries.value.length && !c.selectedFile.value) return '取り出す原稿を選び、内容の取得を終えてください。'
  return ''
})
const restoreItems = computed(() => c.restoreBranches.value.map(branch => ({
  value: branch.name, title: `${formatGitDate(branch.date)} · ${branch.message || 'メモなし'} (${branch.name})`,
})))
// VSelectの標準の閉じ方を維持し、選択メニューが消えた後にフォーカスを復帰する。
const selectMenuProps = { closeOnContentClick: false, onAfterLeave: restoreOperationFocus }
let previousFocus: HTMLElement | null = null
watch(c.isOpen, (open) => { if (open) { detailsOpen.value = false; folderMenuOpen.value = false } })
watch(c.pending, (pending) => {
  if (pending) {
    if (document.activeElement instanceof HTMLElement && panel.value?.$el.contains(document.activeElement)) previousFocus = document.activeElement
  } else { void restoreOperationFocus() }
}, { flush: 'sync' })

/** 無効化する前の操作位置を記憶し、完了後にキーボード操作を続けられるようにする。 */
function rememberFocus(event: FocusEvent): void {
  if (!c.pending.value && event.target instanceof HTMLElement) previousFocus = event.target
}

/** 処理後は元の操作へ戻し、別のダイアログや利用者のフォーカス移動は奪わない。 */
async function restoreOperationFocus(): Promise<void> {
  await nextTick()
  if (!previousFocus || !c.isOpen.value || c.locked.value || c.restoreSource.value || c.savePrompt.value) return
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body && active !== previousFocus
    && active.getClientRects().length
    && active.matches('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')) return
  const target = previousFocus.isConnected && !previousFocus.closest('[hidden]') && previousFocus.getClientRects().length
    ? previousFocus : panel.value?.$el.querySelector<HTMLElement>('[data-git-refresh]')
  target?.focus({ preventScroll: true }); previousFocus = null
}

/** 案内先に移動して操作位置を示す。移動だけでは原稿・履歴・保管先を変更しない。 */
async function navigateTo(target: GitNextTarget): Promise<void> {
  if (c.locked.value || !target) return
  if (target === 'editor') { c.close(); return }
  if (target === 'refresh') { await c.refresh(); return }
  if (target === 'details') detailsOpen.value = true
  else c.showTab(target)
  await nextTick()
  const selector = target === 'details' ? '.git-details > summary' : `#git-${target}-panel`
  const destination = panel.value?.$el.querySelector<HTMLElement>(selector)
  destination?.scrollIntoView({ block: 'nearest' }); destination?.focus({ preventScroll: true })
}
</script>

<template>
  <VDialog :model-value="c.isOpen.value" :persistent="c.locked.value || c.savePrompt.value || !!c.restoreSource.value" max-width="1040" scrollable aria-label="履歴とバックアップ" @update:model-value="c.close" @after-leave="emit('closed')">
    <VCard ref="panel" class="git-history" @focusin="rememberFocus">
      <VCardTitle>履歴とバックアップ</VCardTitle>
      <VCardText>
        <div class="git-actions git-folder-header mb-3">
          <template v-if="c.workspace.value">
            <VSelect v-if="c.workspaces.value.length > 1" :model-value="c.selectedId.value" :items="c.workspaces.value" item-title="root" item-value="id" label="履歴を残す原稿フォルダー" :disabled="c.locked.value || c.listFailed.value" :menu-props="selectMenuProps" hide-details class="git-folder-path" @update:model-value="c.select" />
            <p v-else class="git-path git-folder-path">対象フォルダー: {{ c.workspace.value.root }}</p>
            <VMenu v-model="folderMenuOpen">
              <template #activator="{ props: menuProps }">
                <VBtn v-bind="menuProps" :disabled="c.locked.value || c.listFailed.value" variant="text" size="small" append-icon="mdi-chevron-down">フォルダーの操作</VBtn>
              </template>
              <VList>
                <VListItem title="原稿フォルダーを追加" :disabled="!c.version.value" @click="c.add" />
                <VListItem title="この一覧から登録を解除" subtitle="原稿・履歴・バックアップは残ります" @click="c.remove" />
              </VList>
            </VMenu>
          </template>
          <VBtn data-git-refresh :disabled="c.locked.value" variant="text" size="small" prepend-icon="mdi-refresh" @click="c.refresh">{{ c.version.value ? '再確認' : 'もう一度確認' }}</VBtn>
        </div>
        <p class="git-flow" aria-label="保存・記録・バックアップの関係">
          <span>執筆画面で原稿を<strong>保存</strong></span><span aria-hidden="true">→</span>
          <span>このPCに<strong>履歴を記録</strong></span><span aria-hidden="true">→</span>
          <span>記録を別の保存先へ<strong>バックアップ</strong></span>
        </p>
        <p class="git-help mb-3">すべて手動です。保存だけでは、履歴の記録やバックアップは行われません。</p>
        <div class="git-progress" role="status" aria-live="polite" aria-atomic="true">
          <template v-if="c.pending.value">
            <VProgressLinear indeterminate :aria-label="c.pendingLabel.value" />
            <p v-if="!c.workspace.value" class="mt-2">{{ c.pendingLabel.value }}… 完了までお待ちください。</p>
          </template>
        </div>
        <GitOperationFeedback v-if="c.feedback.value && !c.restoreSource.value && !(c.listReady.value && !c.listFailed.value && !c.version.value && c.operation.value === 'check')" :feedback="c.feedback.value" />
        <VAlert v-if="c.notice.value" :type="c.noticeTone.value" variant="tonal" class="mb-3 git-message" role="status">
          {{ c.notice.value }}
          <VBtn v-if="c.noticeAction.value === 'backup' && c.tab.value !== 'backup'" :disabled="c.locked.value" class="mt-2" variant="text" @click="navigateTo('backup')">バックアップへ進む</VBtn>
        </VAlert>
        <div v-if="!c.listReady.value && !c.listFailed.value" class="git-empty">
          <p>利用できる機能と登録フォルダーを確認しています。</p>
        </div>
        <VAlert v-if="c.listReady.value && !c.version.value && !c.listFailed.value" type="info" variant="tonal" class="mb-4">
          <strong>履歴を残すための準備が必要です</strong>
          <p class="mt-2">この機能にはGit for Windowsを使用します。インストール後、アプリを再起動してください。Gitのコマンド操作を覚える必要はありません。原稿の編集と通常保存は引き続き使えます。</p>
          <p class="mt-2">公式サイト: <a href="https://git-scm.com/downloads/win" target="_blank" rel="noopener noreferrer">Git for Windowsのダウンロード</a>。導入手順はREADMEでも確認できます。</p>
          <details v-if="c.feedback.value && c.operation.value === 'check'" class="mt-2"><summary>利用できない理由の詳細</summary><p class="git-message">{{ c.feedback.value.details }}</p></details>
        </VAlert>
        <div v-if="c.listReady.value && !c.listFailed.value && !c.workspaces.value.length" class="git-empty">
          <h2>原稿フォルダーを選んで始めましょう</h2>
          <p>原稿が入っている実際のフォルダーを選びます。原稿は移動せず、このフォルダーに履歴を残します。プロジェクトツリーとは別に登録できます。</p>
          <VBtn :disabled="c.locked.value || !c.version.value" color="primary" prepend-icon="mdi-folder-plus-outline" class="mt-3" @click="c.add">原稿フォルダーを選んで始める</VBtn>
          <p class="git-help mt-3">以前のバックアップがある場合は、下の「バックアップからフォルダーを復元」を利用できます。</p>
        </div>
        <template v-if="c.workspace.value">
          <div class="git-state" aria-label="現在の状態" aria-live="polite" aria-atomic="true">
            <div v-for="state in c.overview.value.states" :key="state.title" class="git-state-item" :data-tone="state.tone">
              <div class="git-state-title"><VIcon :icon="state.icon" :color="state.tone === 'neutral' ? undefined : state.tone" size="20" /><strong>{{ state.title }}</strong></div>
              <p class="git-state-message">{{ state.message }}</p>
              <p v-if="state.detail" class="git-help">{{ state.detail }}</p>
            </div>
          </div>
          <div class="git-next" :data-tone="c.overview.value.next.tone" role="status" aria-live="polite">
            <div><strong>次の操作</strong><p>{{ c.overview.value.next.message }}</p></div>
            <VBtn v-if="c.overview.value.next.target && c.overview.value.next.target !== c.tab.value && c.overview.value.next.target !== 'refresh' && c.noticeAction.value !== c.overview.value.next.target" :disabled="c.locked.value" variant="tonal" size="small" @click="navigateTo(c.overview.value.next.target)">{{ c.overview.value.next.action }}</VBtn>
          </div>
          <VTabs :model-value="c.tab.value" grow color="primary" aria-label="履歴とバックアップの目的" class="mb-4" @update:model-value="c.showTab($event)">
            <VTab id="git-record-tab" value="record" aria-controls="git-record-panel">履歴を記録</VTab>
            <VTab id="git-history-tab" value="history" aria-controls="git-history-panel">過去の原稿</VTab>
            <VTab id="git-backup-tab" value="backup" aria-controls="git-backup-panel">バックアップ</VTab>
          </VTabs>
          <section v-show="c.tab.value === 'record'" id="git-record-panel" role="tabpanel" aria-labelledby="git-record-tab" tabindex="0">
            <div v-if="c.status.value && !c.status.value.changes.length" class="git-empty">
              <h2>新しく記録する変更はありません</h2>
              <p>{{ c.status.value.head ? '過去の原稿は、すでに残した履歴から確認できます。新しい変更を記録するときは、編集・保存後に再確認してください。' : '履歴もまだありません。原稿を保存後に再確認してください。対象に出ない原稿は「詳しい情報」で対応範囲を確認できます。' }}</p>
              <VBtn v-if="c.status.value.head && c.overview.value.next.target !== 'history'" :disabled="c.locked.value" variant="text" class="mt-2" @click="navigateTo('history')">過去の原稿を見る</VBtn>
            </div>
            <div v-show="!!c.status.value?.changes.length">
              <h2>保存済みの原稿の状態を、このPCに残す</h2>
              <p class="git-help">原稿（TXT）の追加・変更・削除から、選んだ変更を履歴に残します。現在の原稿は書き換えません。</p>
              <div class="git-actions my-3">
                <strong>選択中: {{ c.selectedPaths.value.length }} / {{ c.status.value?.changes.length || 0 }}件</strong>
                <VBtn :disabled="c.locked.value || !!c.status.value?.blocked" size="small" variant="text" @click="c.selectAll(true)">すべて選択</VBtn>
                <VBtn :disabled="c.locked.value || !!c.status.value?.blocked || !c.selectedPaths.value.length" size="small" variant="text" @click="c.selectAll(false)">選択を解除</VBtn>
              </div>
              <div class="git-change-list" aria-label="記録するTXTの変更">
                <VCheckbox v-for="change in c.status.value?.changes || []" :key="change.path" v-model="c.selectedPaths.value" :value="change.path" :label="`${changeLabels[change.kind]}: ${change.path}`" :disabled="c.locked.value || !!c.status.value?.blocked" hide-details density="compact" />
              </div>
              <VTextField v-model="c.description.value" label="この記録のメモ（省略可）" placeholder="例: 第1章の会話を推敲" :disabled="c.locked.value" class="mt-4" persistent-hint hint="省略すると、日時入りの記録名になります。" />
              <VTextField v-if="!c.status.value?.authorName" v-model="c.authorName.value" label="履歴に表示する名前" :disabled="c.locked.value" persistent-hint hint="本名でなくても構いません。この機能で使う名前として保存します。" class="mt-2" />
            </div>
          </section>
          <section v-show="c.tab.value === 'history'" id="git-history-panel" role="tabpanel" aria-labelledby="git-history-tab" tabindex="0">
            <h2>過去の原稿を見る・別のファイルとして取り出す</h2>
            <p class="git-help">見るだけでは現在の原稿は変わりません。取り出すときも、既存のファイルを上書きせず、編集中の本文は切り替えません。</p>
            <p v-if="c.historyFailed.value" class="git-empty">記録一覧を読み込めませんでした。「再確認」で読み直せます。</p>
            <p v-else-if="!c.historyReady.value" class="git-empty">{{ c.version.value ? '記録一覧を確認中です。' : '履歴機能の準備が必要です。' }}</p>
            <p v-else-if="!c.entries.value.length" class="git-empty">まだ履歴がありません。「履歴を記録」で最初の記録を残してください。</p>
            <div v-else class="git-columns mt-3">
              <div>
                <div class="git-entry-list" aria-label="記録一覧">
                  <button v-for="entry in c.entries.value" :key="entry.id" type="button" class="git-entry" :class="{ selected: c.selectedCommit.value === entry.id }" :disabled="c.locked.value" :aria-pressed="c.selectedCommit.value === entry.id" @click="c.selectCommit(entry.id)">
                    <strong>{{ entry.message || 'メモなし' }}</strong>
                    <span>{{ formatGitDate(entry.date) }}</span>
                    <span>記録者: {{ entry.author }}</span>
                  </button>
                </div>
                <VBtn v-if="c.hasMore.value" :disabled="c.locked.value" variant="text" @click="c.more">さらに50件表示</VBtn>
              </div>
              <div>
                <VSelect :model-value="c.selectedFile.value" :items="c.files.value" label="この記録の原稿（TXT）" :disabled="c.locked.value || !c.filesReady.value || !c.files.value.length" :menu-props="selectMenuProps" hide-details @update:model-value="c.selectFile" />
                <p v-if="!c.selectedCommit.value" class="git-help mt-3">左の記録を選んでください。</p>
                <p v-else-if="c.filesFailed.value" class="git-help mt-3">原稿一覧を読み込めませんでした。記録を選び直してください。</p>
                <p v-else-if="c.filesReady.value && !c.files.value.length" class="git-help mt-3">この記録に対象のTXTはありません。</p>
                <p v-else-if="c.filesReady.value && !c.selectedFile.value && !c.previewError.value" class="git-help mt-3">確認する原稿を選んでください。同名の原稿はフォルダー名で区別できます。</p>
                <VAlert v-if="c.previewError.value" type="warning" variant="tonal" class="my-3">{{ c.previewError.value }}</VAlert>
                <template v-if="c.selectedFile.value && !c.previewError.value">
                  <p class="git-help mt-3">読み取り専用</p>
                  <pre class="git-preview" tabindex="0" aria-label="過去の本文（読み取り専用）">{{ c.preview.value }}</pre>
                  <p v-if="!c.preview.value" class="git-help">この原稿の本文は空です。</p>
                </template>
              </div>
            </div>
          </section>
          <section v-show="c.tab.value === 'backup'" id="git-backup-panel" role="tabpanel" aria-labelledby="git-backup-tab" tabindex="0">
            <h2>{{ c.workspace.value.backup ? '記録を別の保存先にも残す' : '別のドライブに、履歴の保存先を用意する' }}</h2>
            <div v-if="!c.workspace.value.backup" class="git-empty mt-3">
              <p>別ドライブの空フォルダー、または以前のバックアップ先を選びます。設定だけでは、まだ記録を送りません。</p>
              <p class="git-help mt-2">保管専用の形式なので、TXTを直接開く場所ではありません。原稿を使うには取り出し・復元を利用します。</p>
            </div>
            <template v-else>
              <div class="git-actions my-3">
                <p class="git-path git-folder-path">保存先: {{ c.workspace.value.backup }}</p>
                <VBtn :disabled="c.locked.value || !c.status.value" variant="text" size="small" @click="c.setBackup">保存先を変更</VBtn>
              </div>
              <p v-if="c.status.value?.backupState === 'unknown'" class="git-help mb-3">ドライブを接続し、保存先にアクセスできることを確認してから「再確認」を押してください。このPCの履歴は削除していません。</p>
              <p v-if="c.status.value?.backupState === 'different'" class="git-help mb-3">未送信の記録がある場合や、保管先で履歴が変わった場合があります。安全に送れない場合は中止し、既存の履歴を強制的に上書きしません。</p>
            </template>
            <p class="git-help">対象はこのPCに記録した履歴です。未保存・未記録の変更とアプリ設定は含まれません。既存の履歴に記録された画像などは含まれます。</p>
            <p class="git-help mt-2">保管した履歴は、新しいフォルダーへ復元できます。ほかの履歴の系列・タグなど、詳しい対象範囲は下で確認できます。</p>
          </section>
        </template>
        <div v-show="!c.workspace.value || c.tab.value === 'backup'" class="git-restore-entry mt-5">
          <h2>バックアップからフォルダー全体を復元</h2>
          <p class="git-help">原稿と履歴を、新しいフォルダーへ複製します。元のフォルダーがなくても利用でき、既存フォルダーへの上書きはしません。</p>
          <VBtn :disabled="c.locked.value || !c.version.value || c.listFailed.value" variant="tonal" class="mt-3" @click="c.beginRestore">バックアップからフォルダーを復元</VBtn>
        </div>
        <details :open="detailsOpen" class="git-details mt-5" @toggle="detailsOpen = ($event.target as HTMLDetailsElement).open">
          <summary>詳しい情報（Git・対応範囲）</summary>
          <dl class="mt-3">
            <dt>Gitバージョン</dt>
            <dd>{{ c.version.value || (c.listReady.value ? '利用できません' : '未確認') }}</dd>
            <template v-if="c.status.value">
              <dt>現在のブランチ</dt>
              <dd>{{ c.status.value.branch || '未選択' }}</dd>
              <dt>最新の記録ID</dt>
              <dd>{{ c.status.value.head || '記録なし' }}</dd>
              <dt>表示中の記録ID</dt>
              <dd>{{ c.selectedCommit.value || '未選択' }}</dd>
              <dt>既存Gitの記録者設定</dt>
              <dd>名前: {{ c.status.value.authorName || '未設定（この機能の入力を使用）' }} / メール: {{ c.status.value.authorEmail || '未設定（省略時 writer@localhost）' }}</dd>
            </template>
          </dl>
          <p v-if="c.membershipError.value" class="git-message mt-3">最新の履歴への収録確認: {{ c.membershipError.value }}</p>
          <p v-if="c.externalError.value" class="git-message mt-3">現在の原稿の状態確認: {{ c.externalError.value }}</p>
          <VTextField v-if="c.status.value?.changes.length && !c.status.value.authorEmail" v-model="c.authorEmail.value" label="記録者のメール（省略可）" :disabled="c.locked.value" persistent-hint hint="この機能でのみ補います。グローバルなGit設定は変更しません。省略時は writer@localhost です。" class="mt-3" />
          <p class="git-help mt-3">アプリから記録するのはTXTの追加・変更・削除です。Gitの除外設定と属性・改行変換を尊重し、リンク・入れ子のリポジトリ・サブモジュール内部は対象外です。取り出しは記録されたバイト列を維持します。</p>
          <p class="git-help mt-2">バックアップは現在のブランチから到達する履歴が対象です。他ブランチ・タグ・未記録の変更・アプリ設定は含みません。ローカルの保管用bareリポジトリのみ対応し、強制送信はしません。ブランチ操作・マージ・ネットワーク送信は行いません。</p>
          <p class="git-help mt-2">記録はコミットフックや署名を、送信はクライアント側フックを実行しません。これらが必須の運用では既存のGitツールを使用してください。</p>
        </details>
      </VCardText>
      <VCardActions class="git-footer">
        <span v-if="footerReason" id="git-action-reason" class="git-help">{{ footerReason }}</span>
        <VSpacer />
        <VBtn v-if="showRecordAction" color="primary" variant="flat" prepend-icon="mdi-history" :disabled="!!c.recordDisabledReason.value" :aria-describedby="footerReason ? 'git-action-reason' : undefined" @click="c.beginRecord">履歴を記録</VBtn>
        <VBtn v-if="c.workspace.value && c.tab.value === 'history' && c.entries.value.length" color="primary" variant="flat" prepend-icon="mdi-file-export-outline" :disabled="c.locked.value || !c.selectedFile.value" :aria-describedby="footerReason ? 'git-action-reason' : undefined" @click="c.exportFile">別のファイルとして取り出す</VBtn>
        <VBtn v-if="c.workspace.value && c.tab.value === 'backup' && !c.workspace.value.backup" color="primary" variant="flat" prepend-icon="mdi-folder-outline" :disabled="c.locked.value || !c.status.value" :aria-describedby="footerReason ? 'git-action-reason' : undefined" @click="c.setBackup">バックアップ先を選ぶ</VBtn>
        <VBtn v-if="c.workspace.value && c.tab.value === 'backup' && c.workspace.value.backup" color="primary" variant="flat" prepend-icon="mdi-content-save-outline" :disabled="!!c.backupDisabledReason.value" :aria-describedby="footerReason ? 'git-action-reason' : undefined" @click="c.backup">記録をバックアップ</VBtn>
        <VBtn :disabled="c.locked.value" @click="c.close">閉じる</VBtn>
      </VCardActions>
    </VCard>
  </VDialog>
  <VDialog :model-value="c.savePrompt.value" :persistent="c.locked.value" max-width="620" aria-label="未保存の本文" @update:model-value="c.record('cancel')" @after-leave="restoreOperationFocus">
    <VCard title="まだ保存していない本文があります">
      <VCardText>
        <p>履歴に残せるのは、原稿ファイルへ保存済みの内容です。今の本文も残すには「保存して続ける」を選んでください。</p>
        <p class="git-help mt-3">保存後は変更一覧を確認し、もう一度「履歴を記録」を押します。「保存済みの内容だけ記録」では、今の未保存の編集は履歴に含まれません。</p>
      </VCardText>
      <VCardActions class="git-actions">
        <VBtn :disabled="c.locked.value" color="primary" variant="flat" @click="c.record('save')">保存して続ける</VBtn>
        <VBtn :disabled="c.locked.value" variant="tonal" @click="c.record('disk')">保存済みの内容だけ記録</VBtn>
        <VBtn :disabled="c.locked.value" @click="c.record('cancel')">キャンセル</VBtn>
      </VCardActions>
    </VCard>
  </VDialog>
  <VDialog :model-value="!!c.restoreSource.value" :persistent="c.locked.value" max-width="700" scrollable aria-label="バックアップからフォルダーを復元" @update:model-value="c.restoreSource.value = ''" @after-leave="restoreOperationFocus">
    <VCard title="バックアップからフォルダーを復元">
      <VCardText>
        <GitOperationFeedback v-if="c.feedback.value" :feedback="c.feedback.value" />
        <p v-if="c.pending.value" role="status">{{ c.pendingLabel.value }}… 完了までお待ちください。</p>
        <p class="git-path mb-3">復元元: {{ c.restoreSource.value }}</p>
        <VSelect v-if="c.restoreBranches.value.length > 1" v-model="c.restoreBranch.value" :items="restoreItems" label="復元する履歴を選択" :disabled="c.locked.value" persistent-hint hint="複数の候補があります。最新記録の日時とメモを確認して選んでください。括弧内はGitのブランチ名です。" />
        <p v-else-if="c.restoreBranches.value[0]" class="mb-3">復元する履歴: {{ formatGitDate(c.restoreBranches.value[0].date) }} · {{ c.restoreBranches.value[0].message || 'メモなし' }}</p>
        <VTextField v-model="c.restoreName.value" label="新しいフォルダー名" :disabled="c.locked.value" class="mt-3" />
        <VBtn :disabled="c.locked.value" variant="tonal" @click="c.chooseRestoreParent">復元先の親フォルダーを選ぶ</VBtn>
        <p class="git-path mt-3">復元先: {{ c.restoreDestination.value || '親フォルダーを選ぶと、完全な復元先を表示します。' }}</p>
        <p class="git-help mt-3">原稿と履歴を新しいフォルダーへ複製します。既存フォルダーは上書きせず、編集中の本文も切り替えません。</p>
        <p id="git-restore-reason" class="git-help mt-2">{{ c.restoreDisabledReason.value }}</p>
      </VCardText>
      <VCardActions class="git-actions">
        <VBtn :disabled="c.locked.value" @click="c.restoreSource.value = ''">キャンセル</VBtn>
        <VSpacer />
        <VBtn :disabled="!!c.restoreDisabledReason.value" color="primary" variant="flat" aria-describedby="git-restore-reason" @click="c.restore">この新しいフォルダーへ復元</VBtn>
      </VCardActions>
    </VCard>
  </VDialog>
</template>

<style scoped>
.git-history h2 { font-size: 1rem; margin-bottom: 8px; }
.git-help { font-size: .8125rem; line-height: 1.7; color: var(--app-muted); margin: 0; }
.git-footer { flex-wrap: wrap; border-top: 1px solid var(--app-border); }
.git-footer > .git-help { flex: 1 1 180px; }
.git-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.git-path, .git-message, .git-details dd { overflow-wrap: anywhere; white-space: pre-wrap; }
.git-path { margin: 0; }
.git-folder-path { flex: 1; min-width: 180px; }
.git-flow { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: .8125rem; line-height: 1.7; margin: 0 0 4px; }
.git-state { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; padding: 14px; background: var(--app-surface); border: 1px solid var(--app-border); margin-bottom: 12px; border-radius: 6px; }
.git-state-item { min-width: 0; overflow-wrap: anywhere; }
.git-state-title { display: flex; gap: 6px; align-items: flex-start; font-size: .875rem; }
.git-state-message { font-size: .875rem; line-height: 1.5; margin: 8px 0 4px; }
.git-state-item[data-tone="neutral"] .v-icon { color: var(--app-muted); }
.git-next { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; padding: 12px 14px; border-left: 3px solid var(--app-border); background: var(--app-surface); margin-bottom: 12px; font-size: .8125rem; line-height: 1.7; }
.git-next > div { flex: 1 1 250px; }
.git-next p { margin: 4px 0 0; }
.git-next[data-tone="warning"] { border-left-color: var(--app-warning); }
.git-next[data-tone="error"] { border-left-color: var(--app-error); }
.git-next[data-tone="info"] { border-left-color: var(--app-info); }
.git-progress:has(.v-progress-linear) { margin-bottom: 16px; }
.git-empty { padding: 20px; border: 1px solid var(--app-border); border-radius: 6px; margin-bottom: 16px; line-height: 1.7; }
.git-empty p { margin: 0; }
.git-columns { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 24px; }
.git-columns > * { min-width: 0; }
.git-change-list, .git-entry-list { max-height: 300px; overflow: auto; }
.git-change-list { border: 1px solid var(--app-border); }
.git-change-list :deep(.v-label) { overflow-wrap: anywhere; white-space: normal; }
.git-entry { display: block; text-align: left; width: 100%; padding: 12px; color: inherit; border: 0; border-radius: 4px; background: transparent; overflow-wrap: anywhere; cursor: pointer; }
.git-entry span { display: block; font-size: .75rem; margin-top: 4px; }
.git-entry:hover { background: var(--app-hover); }
.git-entry.selected { background: var(--app-selected); color: var(--app-onSelected); }
.git-entry:focus-visible, .git-preview:focus-visible { outline: 2px solid var(--app-focus); outline-offset: -2px; }
.git-entry:disabled { opacity: .6; }
.git-preview { margin-top: 8px; padding: 12px; max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; background: var(--app-editorBackground); color: var(--app-editorText); border: 1px solid var(--app-border); }
.git-restore-entry, .git-details { border-top: 1px solid var(--app-border); padding-top: 16px; }
.git-details summary { cursor: pointer; }
.git-details dt { font-weight: 500; margin-top: 10px; }
.git-details dd { margin-top: 3px; }
@media (max-width: 750px) { .git-columns, .git-state { grid-template-columns: 1fr; } .git-state { gap: 12px; } }
@media (max-width: 450px) { .git-folder-header > .git-folder-path { flex-basis: 100%; } }
</style>
