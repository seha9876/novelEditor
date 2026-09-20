<script setup lang="ts">
// 設定の試用値を表示し、変更要求をメインウィンドウへ送る。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  defaultEditorSettings,
  SETTINGS_COMMAND_EVENT,
  SETTINGS_ERROR_EVENT,
  SETTINGS_READY_EVENT,
  SETTINGS_SAVED_EVENT,
  SETTINGS_STATE_EVENT,
  type EditorSettings,
  type NarrowWrapBehavior,
  type SettingsCommand,
  type SettingsSnapshot,
  type WrapMode,
} from './editorSettings'

const settingsWindow = getCurrentWindow()
const snapshot = ref<SettingsSnapshot | null>(null)
const columnsInput = ref('80')
const errorMessage = ref('')
const saving = ref(false)
const modified = computed(() => snapshot.value !== null &&
  JSON.stringify(snapshot.value.draft) !== JSON.stringify(snapshot.value.saved))
const columnError = computed(() => {
  const columns = Number(columnsInput.value)
  return /^[1-9]\d*$/.test(columnsInput.value) && columns <= 500 ? '' : '桁数は1～500の整数で入力してください。'
})
let closingAfterSave = false
let unlistenState: (() => void) | undefined
let unlistenSaved: (() => void) | undefined
let unlistenError: (() => void) | undefined
let unlistenClose: (() => void) | undefined

/** 試用中の設定変更をメインウィンドウへ送り、本文に反映する。 */
async function sendChange(value: Partial<EditorSettings>): Promise<void> {
  errorMessage.value = ''
  try {
    const command: SettingsCommand = { type: 'change', value }
    await emitTo('main', SETTINGS_COMMAND_EVENT, command)
  } catch (error) {
    errorMessage.value = String(error)
  }
}

/** 折り返し方法の選択を試用値へ反映する。 */
function setWrapMode(mode: WrapMode): void {
  if (!snapshot.value) return
  void sendChange({ wrapMode: mode })
}

/** 狭い窓での表示方法を試用値へ反映する。 */
function setNarrowBehavior(behavior: NarrowWrapBehavior): void {
  if (!snapshot.value) return
  void sendChange({ narrowWrapBehavior: behavior })
}

/** 有効な桁数だけを試用値へ反映し、入力途中の空欄は保持する。 */
function onColumnsInput(event: Event): void {
  columnsInput.value = (event.target as HTMLInputElement).value
  if (!snapshot.value || columnError.value) return
  void sendChange({ wrapColumns: Number(columnsInput.value) })
}

/** 指定項目だけ保存値または初期値へ戻して試用する。 */
function restoreField(field: keyof EditorSettings, source: 'saved' | 'default'): void {
  if (!snapshot.value) return
  const original = source === 'saved' ? snapshot.value.saved : defaultEditorSettings
  void sendChange({ [field]: original[field] })
}

/** 全項目を初期値へ戻して試用する。 */
function restoreDefaults(): void {
  void sendChange({ ...defaultEditorSettings })
}

/** 試用中の全項目を保存し、保存完了の通知を待つ。 */
async function saveSettings(): Promise<void> {
  if (!snapshot.value || columnError.value || saving.value) return
  saving.value = true
  try {
    const command: SettingsCommand = { type: 'save' }
    await emitTo('main', SETTINGS_COMMAND_EVENT, command)
  } catch (error) {
    errorMessage.value = String(error)
    saving.value = false
  }
}

/** キャンセル要求を通常のウィンドウ終了処理へ渡す。 */
async function cancelSettings(): Promise<void> {
  await settingsWindow.close()
}

/** Esc をキャンセルとして扱う。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    void cancelSettings()
  }
}

// メインウィンドウの状態を受け取れるようにしてから、現在値を要求する。
onMounted(async () => {
  unlistenState = await listen<SettingsSnapshot>(SETTINGS_STATE_EVENT, (event) => {
    snapshot.value = event.payload
    columnsInput.value = String(event.payload.draft.wrapColumns)
  })
  unlistenSaved = await listen(SETTINGS_SAVED_EVENT, () => {
    closingAfterSave = true
    void settingsWindow.close()
  })
  unlistenError = await listen<string>(SETTINGS_ERROR_EVENT, (event) => {
    errorMessage.value = event.payload
    saving.value = false
  })
  unlistenClose = await settingsWindow.onCloseRequested(async (event) => {
    if (closingAfterSave) return
    event.preventDefault()
    if (saving.value) return
    try {
      const command: SettingsCommand = { type: 'cancel' }
      await emitTo('main', SETTINGS_COMMAND_EVENT, command)
      await settingsWindow.destroy()
    } catch (error) {
      errorMessage.value = String(error)
    }
  })
  window.addEventListener('keydown', onKeydown)
  await emitTo('main', SETTINGS_READY_EVENT)
})

// 設定ウィンドウを破棄する際にイベント購読を解除する。
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unlistenState?.()
  unlistenSaved?.()
  unlistenError?.()
  unlistenClose?.()
})
</script>

<template>
  <main class="settings-shell">
    <header class="settings-header">
      <h1>設定</h1>
      <p>変更は本文へすぐ反映されます。保存するまで再起動後には残りません。</p>
      <span v-if="modified" class="settings-pending">未保存の変更があります</span>
    </header>
    <div v-if="snapshot" class="settings-content" :inert="saving">
      <section class="setting-section" aria-labelledby="wrap-mode-title">
        <h2 id="wrap-mode-title">折り返し方法</h2>
        <label><input type="radio" name="wrap-mode" :checked="snapshot.draft.wrapMode === 'window'" @change="setWrapMode('window')">右端で折り返し</label>
        <label><input type="radio" name="wrap-mode" :checked="snapshot.draft.wrapMode === 'columns'" @change="setWrapMode('columns')">指定桁数で折り返し</label>
        <label><input type="radio" name="wrap-mode" :checked="snapshot.draft.wrapMode === 'none'" @change="setWrapMode('none')">折り返さない</label>
        <div class="setting-actions">
          <button type="button" @click="restoreField('wrapMode', 'saved')">保存値に戻す</button>
          <button type="button" @click="restoreField('wrapMode', 'default')">初期値に戻す</button>
        </div>
      </section>
      <section class="setting-section" aria-labelledby="wrap-columns-title">
        <h2 id="wrap-columns-title">指定桁数</h2>
        <label class="columns-label">桁数 <input type="number" min="1" max="500" step="1" :value="columnsInput" aria-describedby="columns-help" @input="onColumnsInput"></label>
        <p id="columns-help" class="setting-help">現在の書体で、おおよその表示幅を指定します。</p>
        <p v-if="columnError" class="settings-error">{{ columnError }}</p>
        <div class="setting-actions">
          <button type="button" @click="restoreField('wrapColumns', 'saved')">保存値に戻す</button>
          <button type="button" @click="restoreField('wrapColumns', 'default')">初期値に戻す</button>
        </div>
      </section>
      <section class="setting-section" aria-labelledby="narrow-behavior-title">
        <h2 id="narrow-behavior-title">指定桁数が窓より広い場合</h2>
        <label><input type="radio" name="narrow-behavior" :checked="snapshot.draft.narrowWrapBehavior === 'scroll'" @change="setNarrowBehavior('scroll')">指定桁数を優先して横スクロール</label>
        <label><input type="radio" name="narrow-behavior" :checked="snapshot.draft.narrowWrapBehavior === 'fit'" @change="setNarrowBehavior('fit')">窓幅に合わせて早めに折り返す</label>
        <div class="setting-actions">
          <button type="button" @click="restoreField('narrowWrapBehavior', 'saved')">保存値に戻す</button>
          <button type="button" @click="restoreField('narrowWrapBehavior', 'default')">初期値に戻す</button>
        </div>
      </section>
    </div>
    <footer class="settings-footer">
      <p v-if="errorMessage" class="settings-error" role="alert">{{ errorMessage }}</p>
      <button type="button" :disabled="!snapshot || saving" @click="restoreDefaults">すべて初期値に戻す</button>
      <span class="footer-spacer" />
      <button type="button" :disabled="saving" @click="cancelSettings">キャンセル</button>
      <button type="button" class="save-button" :disabled="!snapshot || !!columnError || saving" @click="saveSettings">保存</button>
    </footer>
  </main>
</template>
