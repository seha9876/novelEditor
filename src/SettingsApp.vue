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
function onColumnsInput(value: string | number | null): void {
  columnsInput.value = value === null ? '' : String(value)
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
  <VApp class="settings-shell">
    <VAppBar title="設定" flat>
      <template #append>
        <VChip v-if="modified" class="settings-pending" color="warning" size="small" variant="tonal">未保存の変更があります</VChip>
      </template>
    </VAppBar>
    <VMain>
      <VContainer v-if="snapshot" class="settings-content" fluid :inert="saving">
        <VRow>
          <VCol cols="12">
            <VCard class="setting-card">
              <VCardItem>
                <VCardTitle>折り返し方法</VCardTitle>
                <VCardSubtitle>変更は本文へすぐ反映されます。保存するまで再起動後には残りません。</VCardSubtitle>
              </VCardItem>
              <VCardText>
                <VRadioGroup :model-value="snapshot.draft.wrapMode" aria-label="折り返し方法">
                  <VRadio value="window" label="右端で折り返し" @change="setWrapMode('window')" />
                  <VRadio value="columns" label="指定桁数で折り返し" @change="setWrapMode('columns')" />
                  <VRadio value="none" label="折り返さない" @change="setWrapMode('none')" />
                </VRadioGroup>
                <div class="setting-actions">
                  <VBtn size="small" variant="outlined" @click="restoreField('wrapMode', 'saved')">保存値に戻す</VBtn>
                  <VBtn size="small" variant="outlined" @click="restoreField('wrapMode', 'default')">初期値に戻す</VBtn>
                </div>
              </VCardText>
            </VCard>
          </VCol>
          <VCol cols="12">
            <VCard class="setting-card">
              <VCardItem>
                <VCardTitle>指定桁数</VCardTitle>
                <VCardSubtitle>現在の書体で、おおよその表示幅を指定します。</VCardSubtitle>
              </VCardItem>
              <VCardText>
                <VTextField
                  :model-value="columnsInput"
                  label="桁数"
                  type="number"
                  min="1"
                  max="500"
                  step="1"
                  aria-describedby="columns-help"
                  :error-messages="columnError ? [columnError] : []"
                  @update:model-value="onColumnsInput"
                />
                <p id="columns-help" class="setting-help">1～500の整数で指定します。</p>
                <div class="setting-actions">
                  <VBtn size="small" variant="outlined" @click="restoreField('wrapColumns', 'saved')">保存値に戻す</VBtn>
                  <VBtn size="small" variant="outlined" @click="restoreField('wrapColumns', 'default')">初期値に戻す</VBtn>
                </div>
              </VCardText>
            </VCard>
          </VCol>
          <VCol cols="12">
            <VCard class="setting-card">
              <VCardItem>
                <VCardTitle>指定桁数が窓より広い場合</VCardTitle>
              </VCardItem>
              <VCardText>
                <VRadioGroup :model-value="snapshot.draft.narrowWrapBehavior" aria-label="指定桁数が窓より広い場合">
                  <VRadio value="scroll" label="指定桁数を優先して横スクロール" @change="setNarrowBehavior('scroll')" />
                  <VRadio value="fit" label="窓幅に合わせて早めに折り返す" @change="setNarrowBehavior('fit')" />
                </VRadioGroup>
                <div class="setting-actions">
                  <VBtn size="small" variant="outlined" @click="restoreField('narrowWrapBehavior', 'saved')">保存値に戻す</VBtn>
                  <VBtn size="small" variant="outlined" @click="restoreField('narrowWrapBehavior', 'default')">初期値に戻す</VBtn>
                </div>
              </VCardText>
            </VCard>
          </VCol>
        </VRow>
      </VContainer>
      <VContainer v-else>
        <VAlert type="info" variant="tonal">設定を読み込んでいます。</VAlert>
      </VContainer>
    </VMain>
    <VFooter app class="settings-footer">
      <VAlert v-if="errorMessage" class="settings-error" type="error" variant="tonal" density="compact" role="alert">{{ errorMessage }}</VAlert>
      <VSpacer />
      <VBtn variant="text" :disabled="!snapshot || saving" @click="restoreDefaults">すべて初期値に戻す</VBtn>
      <VBtn variant="text" :disabled="saving" @click="cancelSettings">キャンセル</VBtn>
      <VBtn color="primary" :disabled="!snapshot || !!columnError || saving" :loading="saving" @click="saveSettings">保存</VBtn>
    </VFooter>
  </VApp>
</template>
