/** 同じ色定義をVuetifyとアプリ独自CSSへ適用する。 */
import { colorKeys, type Palette } from './appearance'
import { vuetify } from './vuetify'
let previous: Partial<Palette> = {}
let previousRoot: HTMLElement | undefined

/** 背景に対して読みやすい通知文字とスクロールバーの明暗を選ぶ。 */
function isDark(color: string): boolean {
  const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
  return red * 0.299 + green * 0.587 + blue * 0.114 < 145
}

/** 通知の背景に合わせた文字色を、実画面と配色の見本で共通に選ぶ。 */
export function notificationTextColor(color: string): string {
  return isDark(color) ? '#FFFFFF' : '#000000'
}

/** 装飾用SVGだけを生成し、空白文字の幅やコピー内容には触れない。 */
function whitespaceImage(shape: string, color: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><g stroke="${color}" fill="none" opacity=".65">${shape}</g></svg>`)}")`
}

/** 文書を再生成せず、ルート変数と既存のVuetifyテーマの値だけを更新する。 */
export function applyAppearance(colors: Palette): void {
  const root = document.documentElement
  if (previousRoot !== root) { previous = {}; previousRoot = root }
  for (const key of colorKeys) if (colors[key] !== previous[key]) root.style.setProperty(`--app-${key}`, colors[key])
  if (colors.whitespace !== previous.whitespace) {
    root.style.setProperty('--app-space-image', whitespaceImage('<circle cx="10" cy="10" r="1"/>', colors.whitespace))
    root.style.setProperty('--app-tab-image', whitespaceImage('<path d="M2 10h15m-4-4 4 4-4 4"/>', colors.whitespace))
    root.style.setProperty('--app-full-space-image', whitespaceImage('<rect x="3.5" y="3.5" width="13" height="13"/>', colors.whitespace))
  }
  const theme = vuetify.theme.themes.value.light
  if (colors.background !== previous.background) {
    root.style.colorScheme = isDark(colors.background) ? 'dark' : 'light'
    theme.dark = isDark(colors.background)
  }
  const mapped = {
    background: colors.background, surface: colors.surface, 'surface-light': colors.surfaceLight,
    'on-background': colors.text, 'on-surface': colors.text, 'on-surface-light': colors.text,
    primary: colors.primary, 'on-primary': colors.onPrimary,
    error: colors.error, warning: colors.warning, info: colors.info,
    'on-error': notificationTextColor(colors.error),
    'on-warning': notificationTextColor(colors.warning),
    'on-info': notificationTextColor(colors.info),
  }
  for (const [key, value] of Object.entries(mapped)) if (theme.colors[key] !== value) theme.colors[key] = value
  if (colors.border !== previous.border) theme.variables['border-color'] = colors.border
  if (theme.variables['border-opacity'] !== 1) theme.variables['border-opacity'] = 1
  previous = { ...colors }
}
