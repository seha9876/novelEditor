<script setup lang="ts">
// 文書操作と画面表示をまとめ、本文そのものは EditorPane の CodeMirror に保持する。
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import EditorPane from './EditorPane.vue'
import {
  loadSavedSettings,
  getChangedEditorSettingKeys,
  normalizeEditorSettings,
  SETTINGS_COMMAND_EVENT,
  SETTINGS_ERROR_EVENT,
  SETTINGS_READY_EVENT,
  SETTINGS_SAVED_EVENT,
  SETTINGS_STATE_EVENT,
  SETTINGS_STORAGE_KEY,
  type EditorSettings,
  type SettingsCommand,
  type SettingsSnapshot,
  type WrapMode,
} from './editorSettings'
import {
  chooseSavePath,
  chooseTextFile,
  fileName,
  loadTextFile,
  saveTextFile,
  type LineEnding,
  type TextFile,
} from './textFile'

type EditorHandle = {
  /** CodeMirror が保持する現在の本文を返す。 */
  getText: () => string
  /** 本文と改行形式を切り替え、編集履歴を初期化する。 */
  setDocument: (text: string, lineEnding?: LineEnding) => void
  /** 本文領域へ入力フォーカスを移す。 */
  focus: () => void
}

// 本文は CodeMirror を正本とし、Vue 側には保存時の比較基準と表示に必要な状態だけを置く。
const editor = ref<EditorHandle | null>(null)
const path = ref<string | null>(null)
const savedText = ref('')
const dirty = ref(false)
const charCount = ref(0)
const busy = ref(false)
const currentFile = ref<TextFile | null>(null)
const maximized = ref(false)
const alwaysOnTop = ref(false)
const openMenu = ref<'file' | 'settings' | 'window' | null>(null)
const settingsSubmenuOpen = ref(false)
const appWindow = getCurrentWindow()
const savedSettings = ref(loadSavedSettings())
const draftSettings = ref<EditorSettings>({ ...savedSettings.value })
const settingsPending = computed(() => getChangedEditorSettingKeys(savedSettings.value, draftSettings.value).size > 0)
const fileMenuOpen = computed({
  get: (): boolean => openMenu.value === 'file',
  set: (value: boolean): void => {
    openMenu.value = value ? 'file' : (openMenu.value === 'file' ? null : openMenu.value)
  },
})
const settingsMenuOpen = computed({
  get: (): boolean => openMenu.value === 'settings',
  set: (value: boolean): void => {
    if (!value) settingsSubmenuOpen.value = false
    openMenu.value = value ? 'settings' : (openMenu.value === 'settings' ? null : openMenu.value)
  },
})
const windowMenuOpen = computed({
  get: (): boolean => openMenu.value === 'window',
  set: (value: boolean): void => {
    openMenu.value = value ? 'window' : (openMenu.value === 'window' ? null : openMenu.value)
  },
})
// 保存先が未定なら、上部には新規文書の名前を表示する。
const displayName = computed(() => path.value ? fileName(path.value) : '無題')
let unlistenClose: (() => void) | undefined
let unlistenResize: (() => void) | undefined
let unlistenSettingsCommand: (() => void) | undefined
let unlistenSettingsReady: (() => void) | undefined
let settingsWindowOpening = false

/** CodeMirror から受けた本文と文字数で表示を更新し、保存済み本文との差から未保存状態を判定する。 */
function onChange(text: string, count: number): void {
  charCount.value = count
  dirty.value = text !== savedText.value
}

/** 未保存の変更を破棄してよいか確認し、続行できる場合に true を返す。確認ダイアログを開く。 */
async function confirmDiscard(): Promise<boolean> {
  if (!dirty.value) return true
  return ask('未保存の変更があります。破棄して続けますか？', {
    title: '小説エディタ',
    kind: 'warning',
  })
}

/** 操作名と発生した例外を利用者へ示す。Tauri のエラーダイアログを開く。 */
async function showError(action: string, error: unknown): Promise<void> {
  await message(`${action}に失敗しました。\n${String(error)}`, {
    title: '小説エディタ',
    kind: 'error',
  })
}

/** 必要なら破棄を確認して新規文書へ切り替え、保存先と編集履歴を初期化する。 */
async function newDocument(): Promise<void> {
  if (busy.value || !(await confirmDiscard())) return
  path.value = null
  currentFile.value = null
  savedText.value = ''
  editor.value?.setDocument('')
  editor.value?.focus()
}

/** 選択した TXT を読み込み、本文・保存先・未保存判定の基準を更新する。選択取消時は現状を保つ。 */
async function openDocument(): Promise<void> {
  if (busy.value || !(await confirmDiscard())) return
  busy.value = true
  try {
    const selected = await chooseTextFile()
    if (!selected) return
    const file = await loadTextFile(selected)
    currentFile.value = file
    path.value = file.path
    editor.value?.setDocument(file.text, file.lineEnding)
    // CodeMirror は改行を内部表現へ揃えるため、未保存判定の基準も読み込み後の本文に合わせる。
    file.editorText = editor.value?.getText() ?? file.text
    savedText.value = file.editorText
    dirty.value = false
    editor.value?.focus()
  } catch (error) {
    await showError('ファイルを開く操作', error)
  } finally {
    busy.value = false
  }
}

/** 現在の本文を TXT に書き込み、成功した内容を保存済みの基準にする。保存先がなければ選択を求める。 */
async function saveDocument(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const target = path.value ?? await chooseSavePath('無題.txt')
    if (!target) return
    const text = editor.value?.getText() ?? ''
    const lineEnding = currentFile.value?.lineEnding ?? '\n'
    const hasBom = currentFile.value?.hasBom ?? false
    await saveTextFile(target, text, lineEnding, hasBom, currentFile.value ?? undefined)
    path.value = target
    savedText.value = text
    // 書き込み中にも編集できるので、保存開始時の本文と現在の本文を改めて比較する。
    dirty.value = (editor.value?.getText() ?? '') !== text
  } catch (error) {
    await showError('保存', error)
  } finally {
    busy.value = false
  }
}

/** ウィンドウの最大化状態を取得し、タイトルバーのボタン表示を更新する。 */
async function updateMaximized(): Promise<void> {
  maximized.value = await appWindow.isMaximized()
}

/** 項目選択時にメニューを閉じてから操作を開始する。 */
function runMenuAction(action: () => Promise<void>): void {
  openMenu.value = null
  settingsSubmenuOpen.value = false
  void action()
}

/** 試用中の設定を設定ウィンドウへ送り、両画面の表示を揃える。 */
async function publishSettingsState(): Promise<void> {
  if (!await WebviewWindow.getByLabel('settings')) return
  const snapshot: SettingsSnapshot = { saved: savedSettings.value, draft: draftSettings.value }
  await emitTo('settings', SETTINGS_STATE_EVENT, snapshot)
}

/** メニューから選んだ折り返し方法を試用状態へ反映する。保存は設定画面で行う。 */
async function chooseWrapMode(mode: WrapMode): Promise<void> {
  draftSettings.value = { ...draftSettings.value, wrapMode: mode }
  try {
    await publishSettingsState()
  } catch (error) {
    await showError('設定の同期', error)
  }
}

/** 設定画面から受けた変更・保存・取消をメインウィンドウで処理する。 */
async function handleSettingsCommand(command: SettingsCommand): Promise<void> {
  try {
    if (command.type === 'change') {
      draftSettings.value = normalizeEditorSettings({ ...draftSettings.value, ...command.value })
      await publishSettingsState()
    } else if (command.type === 'cancel') {
      draftSettings.value = { ...savedSettings.value }
      await publishSettingsState()
    } else if (command.type === 'save') {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(draftSettings.value))
      savedSettings.value = { ...draftSettings.value }
      await emitTo('settings', SETTINGS_SAVED_EVENT)
    }
  } catch (error) {
    await emitTo('settings', SETTINGS_ERROR_EVENT, String(error))
  }
}

/** 設定ウィンドウを一つだけ開き、既存のウィンドウがあれば前面へ移す。 */
async function openSettingsWindow(): Promise<void> {
  if (settingsWindowOpening) return
  try {
    const existing = await WebviewWindow.getByLabel('settings')
    if (existing) {
      await existing.setFocus()
      return
    }
    settingsWindowOpening = true
    const settingsWindow = new WebviewWindow('settings', {
      url: 'settings.html',
      title: '設定',
      parent: 'main',
      center: true,
      width: 560,
      height: 520,
      minWidth: 480,
      minHeight: 420,
      decorations: true,
    })
    await settingsWindow.once('tauri://created', () => { settingsWindowOpening = false })
    await settingsWindow.once('tauri://error', (event) => {
      settingsWindowOpening = false
      void showError('設定画面を開く操作', event.payload)
    })
  } catch (error) {
    settingsWindowOpening = false
    await showError('設定画面を開く操作', error)
  }
}

/** ウィンドウを最小化する。 */
async function minimizeWindow(): Promise<void> {
  try {
    await appWindow.minimize()
  } catch (error) {
    await showError('ウィンドウの最小化', error)
  }
}

/** 最大化と元のサイズを切り替え、ボタン表示を現在の状態に合わせる。 */
async function toggleMaximizeWindow(): Promise<void> {
  try {
    await appWindow.toggleMaximize()
    await updateMaximized()
  } catch (error) {
    await showError('ウィンドウのサイズ変更', error)
  }
}

/** メニューから通常の最大化を行う。既に最大化されている場合はそのままにする。 */
async function maximizeWindow(): Promise<void> {
  try {
    await appWindow.maximize()
    await updateMaximized()
  } catch (error) {
    await showError('ウィンドウの最大化', error)
  }
}

/** 現在のモニターの作業領域に合わせ、指定方向だけ窓を広げる。 */
async function maximizeWindowAxis(axis: 'vertical' | 'horizontal'): Promise<void> {
  try {
    if (await appWindow.isMaximized()) await appWindow.unmaximize()
    const monitor = await currentMonitor()
    if (!monitor) throw new Error('現在のモニターを取得できませんでした。')

    const [position, outerSize, innerSize] = await Promise.all([
      appWindow.outerPosition(),
      appWindow.outerSize(),
      appWindow.innerSize(),
    ])
    const workArea = monitor.workArea
    // setSize は内側の寸法を指定するため、外側との差を差し引いて作業領域へ合わせる。
    const targetPosition = new PhysicalPosition(
      axis === 'horizontal' ? workArea.position.x : position.x,
      axis === 'vertical' ? workArea.position.y : position.y,
    )
    const targetSize = new PhysicalSize(
      axis === 'horizontal' ? workArea.size.width - (outerSize.width - innerSize.width) : innerSize.width,
      axis === 'vertical' ? workArea.size.height - (outerSize.height - innerSize.height) : innerSize.height,
    )
    await appWindow.setPosition(targetPosition)
    await appWindow.setSize(targetSize)
    await updateMaximized()
  } catch (error) {
    await showError('ウィンドウのサイズ変更', error)
  }
}

/** 現在のウィンドウの最前面表示を切り替え、成功後にチェック表示を更新する。 */
async function toggleAlwaysOnTop(): Promise<void> {
  try {
    await appWindow.setAlwaysOnTop(!alwaysOnTop.value)
    alwaysOnTop.value = await appWindow.isAlwaysOnTop()
  } catch (error) {
    await showError('常に手前に表示', error)
  }
}

/** 通常の終了要求を送り、既存の未保存確認を通して閉じる。 */
async function closeWindow(): Promise<void> {
  try {
    await appWindow.close()
  } catch (error) {
    await showError('ウィンドウを閉じる操作', error)
  }
}

/** Esc でメニューを閉じ、ファイル操作の Ctrl ショートカットを処理する。Undo/Redo は CodeMirror に任せる。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && settingsSubmenuOpen.value) {
    event.preventDefault()
    settingsSubmenuOpen.value = false
    return
  }
  if (event.key === 'Escape' && openMenu.value) {
    event.preventDefault()
    openMenu.value = null
    return
  }
  if (event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveDocument()
    } else if (event.key.toLowerCase() === 'o') {
      event.preventDefault()
      void openDocument()
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault()
      void newDocument()
    }
  }
}

// 画面のマウント時にショートカットと Tauri のウィンドウ終了要求を購読する。
onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  // 保存処理中や未保存のまま終了しないよう、終了要求を必要に応じて取り消す。
  unlistenClose = await appWindow.onCloseRequested(async (event) => {
    if (busy.value) {
      event.preventDefault()
      return
    }
    if (!dirty.value) return
    // Tauri の終了要求は先に取り消し、確認後に明示的にウィンドウを破棄する。
    event.preventDefault()
    if (await confirmDiscard()) await appWindow.destroy()
  })
  unlistenResize = await appWindow.onResized(() => { void updateMaximized() })
  unlistenSettingsCommand = await listen<SettingsCommand>(SETTINGS_COMMAND_EVENT, (event) => {
    void handleSettingsCommand(event.payload)
  })
  unlistenSettingsReady = await listen(SETTINGS_READY_EVENT, () => { void publishSettingsState() })
  await updateMaximized()
  alwaysOnTop.value = await appWindow.isAlwaysOnTop()
})

// 画面の破棄時に購読を解除し、同じ操作が重複して処理されることを防ぐ。
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unlistenClose?.()
  unlistenResize?.()
  unlistenSettingsCommand?.()
  unlistenSettingsReady?.()
})
</script>

<template>
  <VApp class="app-shell">
    <VAppBar class="titlebar" :height="48" flat>
      <nav class="menu-bar" aria-label="メニューバー">
        <VMenu v-model="fileMenuOpen" :close-on-content-click="false" :transition="false">
          <template #activator="{ props }">
            <VBtn v-bind="props" class="menu-heading" size="small" variant="text">ファイル</VBtn>
          </template>
          <VList density="compact" min-width="220" role="menu" aria-label="ファイル">
            <VListItem role="menuitem" :disabled="busy" title="新規" @click="runMenuAction(newDocument)">
              <template #append><span class="menu-shortcut">Ctrl+N</span></template>
            </VListItem>
            <VListItem role="menuitem" :disabled="busy" title="開く" @click="runMenuAction(openDocument)">
              <template #append><span class="menu-shortcut">Ctrl+O</span></template>
            </VListItem>
            <VListItem role="menuitem" :disabled="busy" title="保存" @click="runMenuAction(saveDocument)">
              <template #append><span class="menu-shortcut">Ctrl+S</span></template>
            </VListItem>
          </VList>
        </VMenu>
        <VMenu v-model="settingsMenuOpen" :close-on-content-click="false" :transition="false">
          <template #activator="{ props }">
            <VBtn v-bind="props" class="menu-heading" size="small" variant="text">設定</VBtn>
          </template>
          <VList density="compact" min-width="240" role="menu" aria-label="設定">
            <VListItem role="menuitem" title="設定画面を開く" @click="runMenuAction(openSettingsWindow)">
              <template #append><span v-if="settingsPending" class="menu-shortcut">未保存</span></template>
            </VListItem>
            <VDivider class="my-1" />
            <VMenu v-model="settingsSubmenuOpen" location="end" open-on-hover :close-on-content-click="false" :open-delay="100" :close-delay="200">
              <template #activator="{ props: submenuProps }">
                <VListItem v-bind="submenuProps" role="menuitem" title="折り返し設定" append-icon="mdi-chevron-right" />
              </template>
              <VList density="compact" min-width="240" role="menu" aria-label="折り返し設定">
                <VListItem role="menuitemradio" :aria-checked="draftSettings.wrapMode === 'window'" :active="draftSettings.wrapMode === 'window'" title="右端で折り返し" @click="runMenuAction(() => chooseWrapMode('window'))">
                  <template #prepend><VIcon icon="mdi-check" :style="{ visibility: draftSettings.wrapMode === 'window' ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
                </VListItem>
                <VListItem role="menuitemradio" :aria-checked="draftSettings.wrapMode === 'columns'" :active="draftSettings.wrapMode === 'columns'" title="指定桁数で折り返し" @click="runMenuAction(() => chooseWrapMode('columns'))">
                  <template #prepend><VIcon icon="mdi-check" :style="{ visibility: draftSettings.wrapMode === 'columns' ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
                </VListItem>
                <VListItem role="menuitemradio" :aria-checked="draftSettings.wrapMode === 'none'" :active="draftSettings.wrapMode === 'none'" title="折り返さない" @click="runMenuAction(() => chooseWrapMode('none'))">
                  <template #prepend><VIcon icon="mdi-check" :style="{ visibility: draftSettings.wrapMode === 'none' ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
                </VListItem>
              </VList>
            </VMenu>
          </VList>
        </VMenu>
        <VMenu v-model="windowMenuOpen" :close-on-content-click="false" :transition="false">
          <template #activator="{ props }">
            <VBtn v-bind="props" class="menu-heading" size="small" variant="text">ウィンドウ</VBtn>
          </template>
          <VList density="compact" min-width="260" role="menu" aria-label="ウィンドウ">
            <VListItem role="menuitem" title="最小化" @click="runMenuAction(minimizeWindow)" />
            <VListItem role="menuitem" title="最大化" @click="runMenuAction(maximizeWindow)" />
            <VListItem role="menuitem" title="縦方向に最大化" @click="runMenuAction(() => maximizeWindowAxis('vertical'))" />
            <VListItem role="menuitem" title="横方向に最大化" @click="runMenuAction(() => maximizeWindowAxis('horizontal'))" />
            <VListItem role="menuitemcheckbox" :aria-checked="alwaysOnTop" :active="alwaysOnTop" title="常に手前に表示" @click="runMenuAction(toggleAlwaysOnTop)">
              <template #prepend><VIcon icon="mdi-check" :style="{ visibility: alwaysOnTop ? 'visible' : 'hidden' }" aria-hidden="true" /></template>
            </VListItem>
            <VDivider class="my-1" />
            <VListItem role="menuitem" title="閉じる" @click="runMenuAction(closeWindow)" />
          </VList>
        </VMenu>
        <VBtn class="menu-heading menu-placeholder" size="small" variant="text" disabled>ヘルプ</VBtn>
      </nav>
      <div class="titlebar-drag-region" data-tauri-drag-region :title="path ?? '新規文書'">
        <div class="document-title">
          <span class="file-name">{{ displayName }}</span>
          <span v-if="dirty" class="dirty-indicator" aria-label="未保存">未保存</span>
        </div>
      </div>
      <div class="window-controls" aria-label="ウィンドウ操作">
        <VBtn icon variant="text" size="small" aria-label="最小化" title="最小化" @click="minimizeWindow"><VIcon icon="mdi-minus" aria-hidden="true" /></VBtn>
        <VBtn icon variant="text" size="small" :aria-label="maximized ? '元に戻す' : '最大化'" :title="maximized ? '元に戻す' : '最大化'" @click="toggleMaximizeWindow"><VIcon :icon="maximized ? 'mdi-window-restore' : 'mdi-square-outline'" aria-hidden="true" /></VBtn>
        <VBtn class="window-close" icon variant="text" size="small" aria-label="閉じる" title="閉じる" @click="closeWindow"><VIcon icon="mdi-close" aria-hidden="true" /></VBtn>
      </div>
    </VAppBar>
    <VMain class="writing-area" aria-label="本文編集領域">
      <EditorPane ref="editor" :settings="draftSettings" @change="onChange" />
    </VMain>
    <VFooter app class="status-bar" height="36">{{ charCount.toLocaleString('ja-JP') }} 文字</VFooter>
  </VApp>
</template>
