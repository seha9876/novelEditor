/** 配色の項目定義・プリセット・外部ファイル形式をUIから独立して管理する。 */
export const colorDefinitions = {
  background: ['共通部品', '背景', '#FFFFFF', '#181B20', '#F5EEDC'],
  surface: ['共通部品', 'パネル', '#FFFFFF', '#242830', '#FFF8E8'],
  surfaceLight: ['共通部品', '補助パネル', '#EEEEEE', '#303640', '#EDE2C9'],
  text: ['共通部品', '文字', '#000000', '#E5E9EF', '#40382D'],
  muted: ['共通部品', '補助文字', '#666666', '#ABB5C2', '#756958'],
  border: ['共通部品', '枠線', '#E0E0E0', '#47515F', '#CCBFA4'],
  primary: ['共通部品', 'アクセント', '#1867C0', '#8CBEFF', '#896334'],
  onPrimary: ['共通部品', 'アクセント上の文字', '#FFFFFF', '#122C4D', '#FFFFFF'],
  hover: ['共通部品', 'ホバー', '#F5F5F5', '#353D49', '#EDE2C9'],
  selected: ['共通部品', '選択背景', '#E3EDF8', '#364C69', '#E3D0AE'],
  onSelected: ['共通部品', '選択文字', '#1867C0', '#E5EFFF', '#493418'],
  focus: ['共通部品', 'フォーカス枠', '#1867C0', '#9DC8FF', '#896334'],
  error: ['共通部品', 'エラー', '#B00020', '#FF9BA8', '#A32938'],
  warning: ['共通部品', '警告', '#FB8C00', '#F6C371', '#986000'],
  info: ['共通部品', '通知', '#2196F3', '#8CBEFF', '#356887'],
  editorBackground: ['本文', '背景', '#FFFFFF', '#1C2026', '#FBF3E0'],
  editorText: ['本文', '文字', '#000000', '#E2E7EE', '#40382D'],
  caret: ['本文', 'カーソル', '#263C4A', '#C6DFFF', '#614923'],
  selection: ['本文', '選択背景', '#DCE8ED', '#3E5877', '#DACAAB'],
  selectionText: ['本文', '選択文字', '#000000', '#FFFFFF', '#292218'],
  gutterBackground: ['本文', '行番号の背景', '#F3F5F6', '#242A32', '#EFE4CC'],
  gutterText: ['本文', '行番号の文字', '#687781', '#A1AFBF', '#817258'],
  gutterBorder: ['本文', '行番号の境界', '#DCE2E5', '#3D4855', '#D6C7A8'],
  whitespace: ['本文', '空白記号', '#939DA5', '#8492A5', '#A08D6C'],
  matchBackground: ['検索強調', '一致箇所の背景', '#FFF1A8', '#63521D', '#EEDD9A'],
  matchText: ['検索強調', '一致箇所の文字', '#000000', '#FFF5D0', '#342B16'],
  matchBorder: ['検索強調', '一致箇所の枠線', '#D4BC55', '#C7AD54', '#B8A04B'],
  currentMatchBackground: ['検索強調', '現在の一致箇所の背景', '#FFCC80', '#86521F', '#E4BD78'],
  currentMatchText: ['検索強調', '現在の一致箇所の文字', '#000000', '#FFFFFF', '#342311'],
  currentMatchBorder: ['検索強調', '現在の一致箇所の枠線', '#A56300', '#FFC47C', '#96652D'],
  menuBarBackground: ['各バー', 'メニューバーの背景', '#FFFFFF', '#242830', '#EEE2C9'],
  menuBarText: ['各バー', 'メニューバーの文字', '#000000', '#E5E9EF', '#40382D'],
  menuBarBorder: ['各バー', 'メニューバーの枠線', '#FFFFFF', '#47515F', '#CCBFA4'],
  toolbarBackground: ['各バー', 'ツールバーの背景', '#FFFFFF', '#242830', '#F5EBD6'],
  toolbarText: ['各バー', 'ツールバーの文字', '#000000', '#E5E9EF', '#40382D'],
  toolbarBorder: ['各バー', 'ツールバーの枠線', '#E0E0E0', '#47515F', '#CCBFA4'],
  statusBackground: ['各バー', 'ステータスバーの背景', '#FFFFFF', '#242830', '#EEE2C9'],
  statusText: ['各バー', 'ステータスバーの文字', '#666666', '#ABB5C2', '#756958'],
  statusBorder: ['各バー', 'ステータスバーの枠線', '#FFFFFF', '#47515F', '#CCBFA4'],
  treeBackground: ['プロジェクトツリー', '背景', '#FFFFFF', '#22262D', '#F1E7D1'],
  treeText: ['プロジェクトツリー', '文字', '#000000', '#E5E9EF', '#40382D'],
  treeMuted: ['プロジェクトツリー', '補助文字', '#666666', '#ABB5C2', '#756958'],
  treeBorder: ['プロジェクトツリー', '枠線', '#E0E0E0', '#47515F', '#CCBFA4'],
  treeHover: ['プロジェクトツリー', 'ホバー', '#F0F0F0', '#353D49', '#E8DBC0'],
  treeSelected: ['プロジェクトツリー', '選択行の背景', '#EDF3FA', '#364C69', '#E3D0AE'],
  treeSelectedText: ['プロジェクトツリー', '選択行の文字', '#000000', '#E5EFFF', '#493418'],
  treeActive: ['プロジェクトツリー', '編集中の行の背景', '#E3EDF8', '#2D425C', '#EADBBD'],
  treeActiveText: ['プロジェクトツリー', '編集中の行の文字', '#1867C0', '#A6CEFF', '#77501F'],
  settingsBackground: ['設定画面', '本文領域の背景', '#FFFFFF', '#181B20', '#F5EEDC'],
  settingsText: ['設定画面', '本文領域の文字', '#000000', '#E5E9EF', '#40382D'],
  settingsNavBackground: ['設定画面', 'ナビゲーションの背景', '#FFFFFF', '#242830', '#EEE2C9'],
  settingsNavText: ['設定画面', 'ナビゲーションの文字', '#000000', '#E5E9EF', '#40382D'],
  settingsHeaderBackground: ['設定画面', 'ヘッダーの背景', '#FFFFFF', '#242830', '#EEE2C9'],
  settingsHeaderText: ['設定画面', 'ヘッダーの文字', '#000000', '#E5E9EF', '#40382D'],
  settingsPanel: ['設定画面', '設定パネルの背景', '#FFFFFF', '#242830', '#FFF8E8'],
  searchBackground: ['検索画面・メニュー・ダイアログ', '検索画面の背景', '#FFFFFF', '#242830', '#F5EEDC'],
  searchText: ['検索画面・メニュー・ダイアログ', '検索画面の文字', '#000000', '#E5E9EF', '#40382D'],
  popupBackground: ['検索画面・メニュー・ダイアログ', 'メニューの背景', '#FFFFFF', '#303640', '#FFF8E8'],
  popupText: ['検索画面・メニュー・ダイアログ', 'メニューの文字', '#000000', '#E5E9EF', '#40382D'],
  dialogBackground: ['検索画面・メニュー・ダイアログ', 'ダイアログの背景', '#FFFFFF', '#303640', '#FFF8E8'],
  dialogText: ['検索画面・メニュー・ダイアログ', 'ダイアログの文字', '#000000', '#E5E9EF', '#40382D'],
} as const

export type ColorKey = keyof typeof colorDefinitions
export type Palette = Record<ColorKey, string>
export type ColorPreset = { id: string; name: string; colors: Palette }
export type AppearancePreferences = { colors: Palette; basePresetId: string | null; presets: ColorPreset[] }
export const colorKeys = Object.keys(colorDefinitions) as ColorKey[]

/** 定義表から独立した標準配色を生成する。 */
function createPalette(column: 2 | 3 | 4): Palette {
  return Object.fromEntries(colorKeys.map((key) => [key, colorDefinitions[key][column]])) as Palette
}

export const builtInPresets: readonly ColorPreset[] = [
  { id: 'builtin-light', name: '現行色', colors: createPalette(2) },
  { id: 'builtin-dark', name: 'ダーク', colors: createPalette(3) },
  { id: 'builtin-sepia', name: 'セピア', colors: createPalette(4) },
]

/** 初回起動・旧設定の補完用に現行色を返す。 */
export function createDefaultAppearance(): AppearancePreferences {
  return { colors: createPalette(2), basePresetId: 'builtin-light', presets: [] }
}

/** 6桁RGBだけを受け付け、CSS式などを保存・実行しない。 */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

/** 全色が正しい外部プリセットのみ受理する。 */
function isPalette(value: unknown): value is Palette {
  return !!value && typeof value === 'object' && colorKeys.every((key) => isHexColor((value as Palette)[key]))
}

/** 保存値の欠損した色だけを現行色で補完し、未知の項目は持ち込まない。 */
function normalizePalette(value: unknown): Palette {
  const raw = value && typeof value === 'object' ? value as Partial<Palette> : {}
  return Object.fromEntries(colorKeys.map((key) => [key, isHexColor(raw[key]) ? raw[key].toUpperCase() : colorDefinitions[key][2]])) as Palette
}

/** プリセット名の長さと制御文字を検査する。 */
function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80 && !/[\p{Cc}]/u.test(value)
}

/** 既存設定の配色を復旧し、標準ID・名前の衝突や壊れた登録を除く。 */
export function normalizeAppearance(value: unknown): AppearancePreferences {
  if (!value || typeof value !== 'object') return createDefaultAppearance()
  const raw = value as Partial<AppearancePreferences>
  const ids = new Set(builtInPresets.map((preset) => preset.id))
  const names = new Set(builtInPresets.map((preset) => preset.name))
  const presets: ColorPreset[] = []
  for (const item of Array.isArray(raw.presets) ? raw.presets : []) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !validName(item.name) || names.has(item.name.trim())) continue
    ids.add(item.id)
    names.add(item.name.trim())
    presets.push({ id: item.id, name: item.name.trim(), colors: normalizePalette(item.colors) })
  }
  return { colors: normalizePalette(raw.colors), basePresetId: typeof raw.basePresetId === 'string' && ids.has(raw.basePresetId) ? raw.basePresetId : null, presets }
}

/** 履歴・Storeと参照共有しない配色設定を作る。旧スナップショットにも対応する。 */
export function cloneAppearance(value?: AppearancePreferences): AppearancePreferences {
  if (!value) return createDefaultAppearance()
  return { colors: { ...value.colors }, basePresetId: value.basePresetId, presets: value.presets.map((preset) => ({ ...preset, colors: { ...preset.colors } })) }
}

/** 標準・ユーザー両方から基準プリセットを検索する。 */
export function findColorPreset(value: AppearancePreferences, id = value.basePresetId): ColorPreset | undefined {
  return [...builtInPresets, ...value.presets].find((preset) => preset.id === id)
}

/** 名前付き保存の内容と現在の配色を比較する。 */
export function isAppearanceModified(value: AppearancePreferences): boolean {
  const base = findColorPreset(value)
  return !base || colorKeys.some((key) => value.colors[key] !== base.colors[key])
}

export type AppearanceAction =
  | { type: 'color'; key: ColorKey; value: string; interactionId?: string }
  | { type: 'switch'; id: string; save?: { name?: string; id?: string } }
  | { type: 'save'; name?: string; id?: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'delete'; id: string }
  | { type: 'import'; preset: ColorPreset }

/** UIとメイン側で同じ名前検証を行い、既存登録の意図しない上書きを防ぐ。 */
export function presetNameError(value: AppearancePreferences, name: string, exceptId?: string): string {
  if (!validName(name)) return '名前は1～80文字で入力してください。制御文字は使用できません。'
  return [...builtInPresets, ...value.presets].some((preset) => preset.id !== exceptId && preset.name === name.trim()) ? '同じ名前のプリセットがあります。' : ''
}

/** 現在色を保存する。ID省略は使用中のユーザープリセットへの上書きに限る。 */
function saveCurrentPreset(value: AppearancePreferences, options: { name?: string; id?: string }): void {
  if (options.id) {
    const error = presetNameError(value, options.name ?? '')
    if (error) throw new Error(error)
    const name = options.name!.trim()
    if (findColorPreset(value, options.id)) throw new Error('プリセットIDが重複しています。')
    value.presets.push({ id: options.id, name, colors: { ...value.colors } })
    value.basePresetId = options.id
  } else {
    const preset = value.presets.find((item) => item.id === value.basePresetId)
    if (!preset) throw new Error('標準配色は名前を付けて保存してください。')
    preset.colors = { ...value.colors }
  }
}

/** 1操作を独立した値へ適用する。保存して切替も1回の履歴にまとめる。 */
export function applyAppearanceAction(current: AppearancePreferences, action: AppearanceAction): AppearancePreferences {
  const next = cloneAppearance(current)
  switch (action.type) {
    case 'color':
      if (!colorKeys.includes(action.key) || !isHexColor(action.value)) throw new Error('色は #RRGGBB 形式で指定してください。')
      next.colors[action.key] = action.value.toUpperCase()
      break
    case 'save':
      saveCurrentPreset(next, action)
      break
    case 'switch': {
      if (action.save) saveCurrentPreset(next, action.save)
      const target = findColorPreset(next, action.id)
      if (!target) throw new Error('プリセットが見つかりません。')
      next.colors = { ...target.colors }
      next.basePresetId = target.id
      break
    }
    case 'rename': {
      const preset = next.presets.find((item) => item.id === action.id)
      if (!preset) throw new Error('標準配色の名前は変更できません。')
      const error = presetNameError(next, action.name, action.id)
      if (error) throw new Error(error)
      preset.name = action.name.trim()
      break
    }
    case 'delete':
      if (!next.presets.some((item) => item.id === action.id)) throw new Error('標準配色は削除できません。')
      next.presets = next.presets.filter((item) => item.id !== action.id)
      if (next.basePresetId === action.id) next.basePresetId = null
      break
    case 'import': {
      if (!isPalette(action.preset.colors) || !validName(action.preset.name) || !action.preset.id || findColorPreset(next, action.preset.id)) throw new Error('プリセットが不正です。')
      let name = action.preset.name.trim()
      let suffix = 2
      while (presetNameError(next, name)) name = `${action.preset.name.trim().slice(0, 65)} (${suffix++})`
      next.presets.push({ id: action.preset.id, name, colors: normalizePalette(action.preset.colors) })
      break
    }
  }
  return next
}

/** 保存済みプリセットだけを、本文やローカルIDを含まない共有形式へ変換する。 */
export function exportColorPreset(preset: ColorPreset): string {
  return JSON.stringify({ format: 'novel-editor-color-preset', version: 1, name: preset.name, colors: preset.colors }, null, 2) + '\n'
}

/** JSON全体を検証してから取り込む。未対応の形式を推測して適用しない。 */
export function importColorPreset(text: string, id: string): ColorPreset {
  let raw: unknown
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new Error('JSONファイルを読み取れません。') }
  if (!raw || typeof raw !== 'object') throw new Error('配色プリセットではありません。')
  const value = raw as Record<string, unknown>
  if (value.format !== 'novel-editor-color-preset') throw new Error('配色プリセットの形式が違います。')
  if (value.version !== 1) throw new Error('このバージョンの配色プリセットには対応していません。')
  if (!validName(value.name) || !isPalette(value.colors)) throw new Error('名前または色の指定が不正です。すべての色を #RRGGBB 形式で指定してください。')
  return { id, name: value.name.trim(), colors: normalizePalette(value.colors) }
}
