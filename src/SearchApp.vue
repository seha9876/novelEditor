<script setup lang="ts">
// 検索条件だけを保持する非モーダル画面。本文の操作とUndoはメインウィンドウへ委ねる。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  createSearchConditions, SEARCH_COMMAND_EVENT, SEARCH_STATE_EVENT,
  type SearchAction, type SearchCommand, type SearchField, type SearchSnapshot,
} from './searchSession'

const sessionId = new URLSearchParams(window.location.search).get('session') ?? ''
const conditions = ref(createSearchConditions())
const snapshot = ref<SearchSnapshot | null>(null)
const searchField = ref<HTMLElement | null>(null)
const replaceField = ref<HTMLElement | null>(null)
const errorMessage = ref('')
const closing = ref(false)
const sequence = ref(0)
let lastRevision = -1
let focusRevision = -1
let sendQueue = Promise.resolve()
let unlistenState: (() => void) | undefined
let unlistenClose: (() => void) | undefined

const pending = computed(() => !snapshot.value || snapshot.value.acknowledgedSequence < sequence.value)
const canRun = computed(() => !!snapshot.value && !snapshot.value.locked && !closing.value &&
  !!conditions.value.search && (pending.value || snapshot.value.status === 'found'))
const statusMessage = computed(() => {
  if (snapshot.value?.locked) return '文書の操作が終わるまで検索・置換はできません'
  if (pending.value) return '検索条件を反映しています…'
  const labels = { empty: '検索語を入力してください', invalid: '正規表現が正しくありません', notFound: '該当なし', found: '一致があります' }
  return labels[snapshot.value?.status ?? 'empty']
})

/** 要求の送信順を固定し、途中で送信が失敗しても後続操作を再試行できるようにする。 */
function enqueueCommand(command: SearchCommand): Promise<void> {
  const sending = sendQueue.then(() => emitTo('main', SEARCH_COMMAND_EVENT, command))
  sendQueue = sending.catch((error: unknown) => {
    errorMessage.value = `検索操作を送れません。もう一度操作してください。${String(error)}`
    closing.value = false
  })
  return sendQueue
}

/** 入力直後の操作でも最新条件を同封し、メイン側の古い条件では実行させない。 */
function sendChange(action?: SearchAction): void {
  if (!snapshot.value || closing.value) return
  errorMessage.value = ''
  void enqueueCommand({
    type: action ? 'action' : 'change',
    sessionId,
    sequence: ++sequence.value,
    documentRevision: snapshot.value.documentRevision,
    conditions: { ...conditions.value },
    action,
  })
}

/** 閉じる要求にも最終入力を含め、条件をメイン側へ確定してから窓を破棄してもらう。 */
function requestClose(): void {
  if (closing.value) return
  closing.value = true
  void enqueueCommand({
    type: 'close', sessionId, sequence: ++sequence.value,
    documentRevision: snapshot.value?.documentRevision ?? -1,
    conditions: snapshot.value ? { ...conditions.value } : undefined,
  })
}

/** Vueの描画を待って目的の入力欄へ移動する。本文側へフォーカスは移さない。 */
async function focusField(field: SearchField): Promise<void> {
  await nextTick()
  const input = (field === 'search' ? searchField.value : replaceField.value)?.querySelector('textarea')
  input?.focus()
  input?.select()
}

/** 古い状態通知と未確認入力の上書きを避け、明示的なフォーカス要求だけを適用する。 */
function receiveSnapshot(next: SearchSnapshot): void {
  if (next.sessionId !== sessionId || next.revision <= lastRevision) return
  lastRevision = next.revision
  snapshot.value = next
  if (next.error) {
    errorMessage.value = next.error
    closing.value = false
  }
  if (next.acknowledgedSequence >= sequence.value) conditions.value = { ...next.conditions }
  if (next.focus.revision > focusRevision) {
    focusRevision = next.focus.revision
    void focusField(next.focus.field)
  }
}

/** IME確定や複数行入力を妨げず、検索・置換ウィンドウ内のショートカットを処理する。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.metaKey) return
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
  } else if (event.ctrlKey && !event.shiftKey && ['f', 'h'].includes(event.key.toLowerCase())) {
    event.preventDefault()
    void focusField(event.key.toLowerCase() === 'f' ? 'search' : 'replace')
  } else if (!event.ctrlKey && (event.key === 'F3' || event.key === 'Enter' && !event.shiftKey && event.target instanceof HTMLTextAreaElement)) {
    event.preventDefault()
    if (canRun.value) sendChange(event.key === 'F3' && event.shiftKey ? 'previous' : 'next')
  }
}

// 応答の購読を先に開始してから現在値を要求し、作成直後の通知取りこぼしを防ぐ。
onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  try {
    unlistenState = await listen<SearchSnapshot>(SEARCH_STATE_EVENT, (event) => receiveSnapshot(event.payload))
    unlistenClose = await getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault()
      requestClose()
    })
    await enqueueCommand({ type: 'ready', sessionId })
  } catch (error) {
    errorMessage.value = `検索画面を初期化できません。${String(error)}`
  }
})

// 再表示時に古い購読が残らないよう、画面固有のイベントを解放する。
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unlistenState?.()
  unlistenClose?.()
})
</script>

<template>
  <VApp class="search-shell">
    <VMain>
      <div class="search-content" role="search" aria-label="本文の検索と置換">
        <template v-if="snapshot">
          <div ref="searchField">
            <VTextarea v-model="conditions.search" label="検索" aria-label="検索" rows="2" density="compact" variant="outlined" hide-details :spellcheck="false" :disabled="closing" :error="!pending && snapshot.status === 'invalid'" @update:model-value="sendChange()" />
          </div>
          <div ref="replaceField">
            <VTextarea v-model="conditions.replace" label="置換" aria-label="置換" rows="2" density="compact" variant="outlined" hide-details :spellcheck="false" :disabled="closing" @update:model-value="sendChange()" />
          </div>
          <div class="search-options">
            <VCheckbox v-model="conditions.caseSensitive" label="大文字・小文字を区別" density="compact" hide-details :disabled="closing" @update:model-value="sendChange()" />
            <VCheckbox v-model="conditions.regexp" label="正規表現" density="compact" hide-details :disabled="closing" @update:model-value="sendChange()" />
          </div>
          <div class="search-actions">
            <VBtn size="small" variant="tonal" :disabled="!canRun" @click="sendChange('previous')">前へ</VBtn>
            <VBtn size="small" color="primary" variant="tonal" :disabled="!canRun" @click="sendChange('next')">次へ</VBtn>
            <VBtn size="small" variant="tonal" :disabled="!canRun" @click="sendChange('replace')">1件置換</VBtn>
            <VBtn size="small" variant="tonal" :disabled="!canRun" @click="sendChange('replaceAll')">全置換</VBtn>
            <VSpacer />
            <VBtn size="small" variant="text" :disabled="closing" @click="requestClose">閉じる</VBtn>
          </div>
          <p class="search-status" role="status" aria-live="polite" :class="{ 'text-error': !pending && snapshot.status === 'invalid' }">{{ statusMessage }}</p>
          <p class="search-help">Enter: 次を検索 ／ Shift+Enter: 入力欄で改行 ／ F3・Shift+F3: 前後検索<br>正規表現の置換: $1、$2 でグループを参照 ／ Esc: 本文に戻る</p>
        </template>
        <p v-else role="status">検索画面を準備しています…</p>
        <p v-if="errorMessage" class="text-error" role="alert">{{ errorMessage }}</p>
      </div>
    </VMain>
  </VApp>
</template>
