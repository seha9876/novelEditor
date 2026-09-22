/** 本文の折り返し方法と、指定幅が窓より広い場合の扱い。 */
export type WrapMode = 'window' | 'columns' | 'none'
export type NarrowWrapBehavior = 'scroll' | 'fit'

export type EditorSettings = {
  wrapMode: WrapMode
  wrapColumns: number
  narrowWrapBehavior: NarrowWrapBehavior
}

/** 初回移行時に限って読む、旧LocalStorage設定のキー。 */
export const SETTINGS_STORAGE_KEY = 'novel-editor-settings-v1'

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
