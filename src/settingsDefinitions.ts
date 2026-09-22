/** 設定画面で編集できる具体的なページを識別する。 */
export type SettingsPageId = 'editor.wrapping' | 'appearance.toolbar'

/** 左ナビと本文が表示する対象を識別する。 */
export type SettingsViewId = 'all' | SettingsPageId

/** 設定画面内のカテゴリを識別する。 */
export type SettingsCategoryId = 'editor' | 'appearance'

/** 設定アコーディオンを識別する。ページIDとは分け、同一ページ内で増やせるようにする。 */
export type SettingsSectionId = 'editor.wrapping.behavior' | 'appearance.toolbar.configuration'

/** 設定一覧モードのナビゲーション表示情報。 */
export const settingsAllViewDefinition = {
  id: 'all',
  label: 'すべて表示',
  icon: 'mdi-view-list-outline',
} as const

/** ページの所属カテゴリとナビゲーション表示名を定義する。 */
export type SettingsPageDefinition = {
  id: SettingsPageId
  categoryId: SettingsCategoryId
  label: string
}

/** 1つ以上のページ内に置く意味的な設定グループを定義する。 */
export type SettingsSectionDefinition =
  | {
      id: 'editor.wrapping.behavior'
      pageId: 'editor.wrapping'
      label: string
    }
  | {
      id: 'appearance.toolbar.configuration'
      pageId: 'appearance.toolbar'
      label: string
    }

/** 設定カテゴリの表示情報を定義する。 */
export type SettingsCategoryDefinition = {
  id: SettingsCategoryId
  label: string
  icon: string
}

/** カテゴリIDの追加時に表示定義の不足を型検査で検出する。 */
const settingsCategoryDefinitionById: Record<SettingsCategoryId, SettingsCategoryDefinition> = {
  editor: { id: 'editor', label: 'エディター', icon: 'mdi-text-box-edit-outline' },
  appearance: { id: 'appearance', label: '外観', icon: 'mdi-palette-outline' },
}
export const settingsCategoryDefinitions: ReadonlyArray<SettingsCategoryDefinition> = Object.values(settingsCategoryDefinitionById)

/** ページIDの追加時に表示定義の不足を型検査で検出する。 */
const settingsPageDefinitionById: Record<SettingsPageId, SettingsPageDefinition> = {
  'editor.wrapping': {
    id: 'editor.wrapping',
    categoryId: 'editor',
    label: '折り返し',
  },
  'appearance.toolbar': {
    id: 'appearance.toolbar',
    categoryId: 'appearance',
    label: 'ツールバー',
  },
}
export const settingsPageDefinitions: ReadonlyArray<SettingsPageDefinition> = Object.values(settingsPageDefinitionById)

/** セクションIDの追加時に表示定義の不足を型検査で検出する。 */
const settingsSectionDefinitionById: Record<SettingsSectionId, SettingsSectionDefinition> = {
  'editor.wrapping.behavior': { id: 'editor.wrapping.behavior', pageId: 'editor.wrapping', label: '折り返し方法' },
  'appearance.toolbar.configuration': { id: 'appearance.toolbar.configuration', pageId: 'appearance.toolbar', label: 'ツールバーの表示と構成' },
}
export const settingsSectionDefinitions: ReadonlyArray<SettingsSectionDefinition> = Object.values(settingsSectionDefinitionById)

/** ページIDをキーにした表示名をナビとヘッダーで共有する。 */
export const settingsPageLabels: Readonly<Record<SettingsPageId, string>> =
  Object.fromEntries(settingsPageDefinitions.map((page) => [page.id, page.label])) as Record<SettingsPageId, string>

/** セクションIDをキーにした表示名を本文と検索用メタデータで共有する。 */
export const settingsSectionLabels: Readonly<Record<SettingsSectionId, string>> =
  Object.fromEntries(settingsSectionDefinitions.map((section) => [section.id, section.label])) as Record<SettingsSectionId, string>

/** アコーディオン開閉の初期状態に利用する全セクションIDを返す。 */
export const allSettingsSectionIds: SettingsSectionId[] = settingsSectionDefinitions.map((section) => section.id)
