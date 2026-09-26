/** 設定画面の数値入力途中状態と、メイン画面からの設定同期を管理する。 */
import { computed, ref, type Ref } from 'vue'
import {
  defaultEditorSettings,
  isValidTypographyNumber,
  type EditorSettings,
} from './editorSettings'
import type { SettingsCommand, SettingsSnapshot } from './settingsSession'

const typographyFields = ['fontSize', 'lineHeight'] as const
export type TypographyField = typeof typographyFields[number]

type SendSettingsCommand = (command: SettingsCommand) => Promise<void>

export type EditorSettingsDraftOptions = {
  snapshot: Ref<SettingsSnapshot | null>
  sendCommand: SendSettingsCommand
  defaultSettings?: EditorSettings
}

/** 本文設定の入力途中状態、検証、確定操作を画面から分離する。 */
export function useEditorSettingsDrafts(options: EditorSettingsDraftOptions) {
  const { snapshot, sendCommand, defaultSettings = defaultEditorSettings } = options
  const columnsValue = ref(defaultSettings.wrapColumns)
  const columnsInput = ref(String(defaultSettings.wrapColumns))
  const columnsInputDirty = ref(false)
  let columnsPendingValue: number | null = null
  const typographyValues = ref({ fontSize: defaultSettings.fontSize, lineHeight: defaultSettings.lineHeight })
  const typographyInputs = ref({ fontSize: String(defaultSettings.fontSize), lineHeight: String(defaultSettings.lineHeight) })
  const typographyDirty = { fontSize: false, lineHeight: false }
  const typographyPendingValues: Record<TypographyField, number | null> = { fontSize: null, lineHeight: null }
  let lastSnapshotRevision = -1

  /** 数値は十進表記と範囲を検証し、不正な入力は設定値へ送らない。 */
  function typographyInputError(field: TypographyField): string {
    const input = typographyInputs.value[field]
    if (/^\d+(?:\.\d+)?$/.test(input) && isValidTypographyNumber(field, Number(input))) return ''
    return field === 'fontSize'
      ? '12～48の整数を入力してください。変更は保存されていません。'
      : '1.0～3.0を0.1刻みで入力してください。変更は保存されていません。'
  }

  const typographyErrors = computed(() => ({
    fontSize: typographyInputError('fontSize'),
    lineHeight: typographyInputError('lineHeight'),
  }))
  const columnError = computed(() => {
    const columns = Number(columnsInput.value)
    return /^[1-9]\d*$/.test(columnsInput.value) && Number.isInteger(columns) && columns <= 500
      ? ''
      : '1～500の整数を入力してください。変更は保存されていません。'
  })
  const hasInputError = computed(() => Boolean(columnError.value || typographyErrors.value.fontSize || typographyErrors.value.lineHeight))

  /** 文字サイズ・行間の入力途中の文字列を保持し、エラー表示へ反映する。 */
  function onTypographyInput(field: TypographyField, value: string): void {
    typographyInputs.value[field] = value
    typographyDirty[field] = true
  }

  /** 有効な文字サイズ・行間を即時反映し、共通のUndo・自動保存経路へ送る。 */
  function onTypographyValue(field: TypographyField, value: number): void {
    if (!snapshot.value || typographyErrors.value[field] || !isValidTypographyNumber(field, value)) return
    typographyValues.value[field] = value
    typographyDirty[field] = true
    const hasPendingValue = typographyPendingValues[field] !== null
    if (!hasPendingValue && snapshot.value.editor[field] === value) return

    typographyPendingValues[field] = value
    void sendCommand({ type: 'change', editor: { [field]: value } })
  }

  /** スピン操作やホイール操作の後、確定済み数値へ入力状態をそろえる。 */
  function onTypographyInteraction(field: TypographyField, value: number): void {
    if (!snapshot.value || typographyErrors.value[field] || !isValidTypographyNumber(field, value)) return
    typographyValues.value[field] = value
    typographyInputs.value[field] = String(value)
    typographyDirty[field] = false
  }

  /** フォーカス移動後の有効値を整え、保存待ちの変更を確実に書き出す。 */
  function commitTypographyInput(field: TypographyField): void {
    if (!snapshot.value || typographyErrors.value[field]) return
    const value = Number(typographyInputs.value[field])
    if (!isValidTypographyNumber(field, value)) return
    typographyValues.value[field] = value
    typographyInputs.value[field] = String(value)
    typographyDirty[field] = false
    if (typographyPendingValues[field] === null && snapshot.value.editor[field] === value) return
    typographyPendingValues[field] = value
    void sendCommand({ type: 'change', editor: { [field]: value }, flush: true })
  }

  /** 現在値より古い状態通知で入力欄を巻き戻さないよう、反映待ちの値を記録する。 */
  function trackTypographyPendingValue(field: TypographyField, value: number): void {
    if (!snapshot.value) return
    if (typographyPendingValues[field] !== null || snapshot.value.editor[field] !== value) {
      typographyPendingValues[field] = value
    }
  }

  /** 指定桁数の入力途中の文字列を保持し、エラー表示へ反映する。 */
  function onColumnsInput(value: string): void {
    columnsInput.value = value
    columnsInputDirty.value = true
  }

  /** 有効な指定桁数を即時反映し、共通のUndo・自動保存経路へ送る。 */
  function onColumnsValue(value: number): void {
    if (!snapshot.value || columnError.value || !Number.isInteger(value) || value < 1 || value > 500) return
    columnsValue.value = value
    columnsInputDirty.value = true
    if (columnsPendingValue === null && snapshot.value.editor.wrapColumns === value) return

    columnsPendingValue = value
    void sendCommand({ type: 'change', editor: { wrapColumns: value } })
  }

  /** 指定桁数のスピン操作やホイール操作後に、dirty状態を解除する。 */
  function onColumnsInteraction(value: number): void {
    if (!snapshot.value || columnError.value || !Number.isInteger(value) || value < 1 || value > 500) return
    columnsValue.value = value
    columnsInput.value = String(value)
    columnsInputDirty.value = false
  }

  /** フォーカス移動後の有効な桁数を整え、保存待ちの変更を確実に書き出す。 */
  function commitColumnsInput(): void {
    if (!snapshot.value || columnError.value) return
    const wrapColumns = Number(columnsInput.value)
    columnsValue.value = wrapColumns
    columnsInput.value = String(wrapColumns)
    columnsInputDirty.value = false
    if (columnsPendingValue === null && snapshot.value.editor.wrapColumns === wrapColumns) return
    columnsPendingValue = wrapColumns
    void sendCommand({ type: 'change', editor: { wrapColumns }, flush: true })
  }

  /** 表示中の状態通知に先行して入力した指定桁数を、同期完了まで保持する。 */
  function trackColumnsPendingValue(value: number): void {
    if (!snapshot.value) return
    if (columnsPendingValue !== null || snapshot.value.editor.wrapColumns !== value) {
      columnsPendingValue = value
    }
  }

  /** 個別設定を対応する初期値へ戻し、数値入力欄も同じ初期値へ更新する。 */
  function restoreField(field: keyof EditorSettings): void {
    if (!snapshot.value) return
    if (field === 'wrapColumns') {
      columnsValue.value = defaultSettings.wrapColumns
      columnsInput.value = String(defaultSettings.wrapColumns)
      columnsInputDirty.value = false
      trackColumnsPendingValue(defaultSettings.wrapColumns)
    }
    if (field === 'fontSize' || field === 'lineHeight') {
      typographyValues.value[field] = defaultSettings[field]
      typographyInputs.value[field] = String(defaultSettings[field])
      typographyDirty[field] = false
      trackTypographyPendingValue(field, defaultSettings[field])
    }
    const editor = field === 'fontFamily'
      ? { fontFamily: defaultSettings.fontFamily, fontFallback: defaultSettings.fontFallback }
      : { [field]: defaultSettings[field] }
    void sendCommand({ type: 'change', editor })
  }

  /** 全設定初期化時に数値入力の表示と未反映値を初期値へそろえる。 */
  function resetDrafts(): void {
    columnsValue.value = defaultSettings.wrapColumns
    trackColumnsPendingValue(defaultSettings.wrapColumns)
    columnsInput.value = String(defaultSettings.wrapColumns)
    columnsInputDirty.value = false
    for (const field of typographyFields) {
      typographyValues.value[field] = defaultSettings[field]
      trackTypographyPendingValue(field, defaultSettings[field])
      typographyInputs.value[field] = String(defaultSettings[field])
      typographyDirty[field] = false
    }
  }

  /** 新しい状態をrevision順に受け取り、編集中の入力文字列を維持する。 */
  function receiveSettingsSnapshot(nextSnapshot: SettingsSnapshot): boolean {
    if (nextSnapshot.revision < lastSnapshotRevision) return false
    lastSnapshotRevision = nextSnapshot.revision
    const previousSnapshot = snapshot.value
    const editorValueChanged = previousSnapshot !== null &&
      previousSnapshot.editor.wrapColumns !== nextSnapshot.editor.wrapColumns
    snapshot.value = nextSnapshot
    if (columnsPendingValue !== null && columnsPendingValue === nextSnapshot.editor.wrapColumns) {
      columnsPendingValue = null
    }
    if ((!previousSnapshot || editorValueChanged) && !columnsInputDirty.value && columnsPendingValue === null) {
      columnsValue.value = nextSnapshot.editor.wrapColumns
      columnsInput.value = String(nextSnapshot.editor.wrapColumns)
    }
    for (const field of typographyFields) {
      if (typographyPendingValues[field] !== null && typographyPendingValues[field] === nextSnapshot.editor[field]) {
        typographyPendingValues[field] = null
      }
      if ((!previousSnapshot || previousSnapshot.editor[field] !== nextSnapshot.editor[field]) && !typographyDirty[field] && typographyPendingValues[field] === null) {
        typographyValues.value[field] = nextSnapshot.editor[field]
        typographyInputs.value[field] = String(nextSnapshot.editor[field])
      }
    }
    return true
  }

  return {
    columnsValue,
    columnsInput,
    columnsInputDirty,
    columnError,
    typographyFields,
    typographyValues,
    typographyInputs,
    typographyErrors,
    hasInputError,
    onColumnsInput,
    onColumnsValue,
    onColumnsInteraction,
    commitColumnsInput,
    onTypographyInput,
    onTypographyValue,
    onTypographyInteraction,
    commitTypographyInput,
    restoreField,
    resetDrafts,
    receiveSettingsSnapshot,
  }
}
