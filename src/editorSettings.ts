/** 本文の折り返し方法と、指定幅が窓より広い場合の扱い。 */
export type WrapMode = 'window' | 'columns' | 'none'
export type NarrowWrapBehavior = 'scroll' | 'fit'

export type EditorSettings = {
  wrapMode: WrapMode
  wrapColumns: number
  narrowWrapBehavior: NarrowWrapBehavior
  fontFamily: string
  fontFallback: 'serif' | 'sans-serif'
  fontSize: number
  lineHeight: number
}

/** 初回移行時に限って読む、旧LocalStorage設定のキー。 */
export const SETTINGS_STORAGE_KEY = 'novel-editor-settings-v1'

export const defaultEditorSettings: EditorSettings = {
  wrapMode: 'window',
  wrapColumns: 80,
  narrowWrapBehavior: 'scroll',
  fontFamily: 'Yu Mincho',
  fontFallback: 'serif',
  fontSize: 18,
  lineHeight: 1.9,
}

/** 今回の選択候補。保存形式は候補IDに依存させず、任意のフォント名を保持する。 */
export const editorFontOptions = [
  { label: '明朝体', fontFamily: 'Yu Mincho', fontFallback: 'serif' },
  { label: 'ゴシック体', fontFamily: 'Yu Gothic', fontFallback: 'sans-serif' },
  { label: 'メイリオ', fontFamily: 'Meiryo', fontFallback: 'sans-serif' },
] as const

/** 書体名をCSSの単一文字列として引用し、フォールバックと安全に組み合わせる。 */
export function editorFontCss(settings: Pick<EditorSettings, 'fontFamily' | 'fontFallback'>): string {
  const family = settings.fontFamily.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${family}", ${settings.fontFallback}`
}

/** サイズ・行間のUI入力と保存値で同じ範囲を検証する。 */
export function isValidTypographyNumber(field: 'fontSize' | 'lineHeight', value: number): boolean {
  if (!Number.isFinite(value)) return false
  return field === 'fontSize'
    ? Number.isInteger(value) && value >= 12 && value <= 48
    : value >= 1 && value <= 3 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9
}

/** IME変換中のEnterを設定値の確定として扱わない。 */
export function shouldCommitTypographyInput(event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>): boolean {
  return event.key === 'Enter' && !event.isComposing && event.keyCode !== 229
}

/** ツールバーの候補一覧を設定値と同じ範囲・刻みで作る。 */
export function getTypographyNumberOptions(field: 'fontSize' | 'lineHeight'): number[] {
  return field === 'fontSize'
    ? Array.from({ length: 37 }, (_, index) => index + 12)
    : Array.from({ length: 21 }, (_, index) => Number(((index + 10) / 10).toFixed(1)))
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
    fontFamily: typeof settings.fontFamily === 'string' && settings.fontFamily.trim() && !/[\p{Cc}]/u.test(settings.fontFamily)
      ? settings.fontFamily.trim() : defaultEditorSettings.fontFamily,
    fontFallback: settings.fontFallback === 'serif' || settings.fontFallback === 'sans-serif'
      ? settings.fontFallback : defaultEditorSettings.fontFallback,
    fontSize: typeof settings.fontSize === 'number' && isValidTypographyNumber('fontSize', settings.fontSize)
      ? settings.fontSize : defaultEditorSettings.fontSize,
    lineHeight: typeof settings.lineHeight === 'number' && isValidTypographyNumber('lineHeight', settings.lineHeight)
      ? settings.lineHeight : defaultEditorSettings.lineHeight,
  }
}
