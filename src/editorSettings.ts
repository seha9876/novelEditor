/** 本文の折り返し方法と、指定幅が窓より広い場合の扱い。 */
export type WrapMode = 'window' | 'columns' | 'none'
export type NarrowWrapBehavior = 'scroll' | 'fit'

export type EditorSettings = {
  wrapMode: WrapMode
  wrapColumns: number
  narrowWrapBehavior: NarrowWrapBehavior
}

export type SettingsSnapshot = {
  saved: EditorSettings
  draft: EditorSettings
}

export type SettingsCommand =
  | { type: 'change'; value: Partial<EditorSettings> }
  | { type: 'save' }
  | { type: 'cancel' }

export const SETTINGS_STORAGE_KEY = 'novel-editor-settings-v1'
export const SETTINGS_COMMAND_EVENT = 'editor-settings-command'
export const SETTINGS_READY_EVENT = 'editor-settings-ready'
export const SETTINGS_STATE_EVENT = 'editor-settings-state'
export const SETTINGS_SAVED_EVENT = 'editor-settings-saved'
export const SETTINGS_ERROR_EVENT = 'editor-settings-error'

export const defaultEditorSettings: EditorSettings = {
  wrapMode: 'window',
  wrapColumns: 80,
  narrowWrapBehavior: 'scroll',
}

/** 外部から読み込んだ値を検査し、不正な項目は既定値へ戻す。 */
export function normalizeEditorSettings(value: unknown): EditorSettings {
  if (!value || typeof value !== 'object') return { ...defaultEditorSettings }
  const settings = value as Partial<EditorSettings>
  return {
    wrapMode: settings.wrapMode === 'window' || settings.wrapMode === 'columns' || settings.wrapMode === 'none'
      ? settings.wrapMode : defaultEditorSettings.wrapMode,
    wrapColumns: Number.isInteger(settings.wrapColumns) && Number(settings.wrapColumns) >= 1 && Number(settings.wrapColumns) <= 500
      ? Number(settings.wrapColumns) : defaultEditorSettings.wrapColumns,
    narrowWrapBehavior: settings.narrowWrapBehavior === 'scroll' || settings.narrowWrapBehavior === 'fit'
      ? settings.narrowWrapBehavior : defaultEditorSettings.narrowWrapBehavior,
  }
}

/** 前回保存した設定を読み込み、未保存または読み取り不能なら既定値を返す。 */
export function loadSavedSettings(): EditorSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY)
    return stored ? normalizeEditorSettings(JSON.parse(stored)) : { ...defaultEditorSettings }
  } catch {
    return { ...defaultEditorSettings }
  }
}
