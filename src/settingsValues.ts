/** 本文・ツールバー・ステータスバー・バーサイズを履歴用の独立した値として扱う。 */
import {
  cloneInterfaceBarSizes,
  cloneStatusBarPreferences,
  type InterfaceBarSizes,
  type StatusBarPreferences,
  type ToolbarPreferences,
} from './appPreferenceSchema'
import type { EditorSettings } from './editorSettings'

export type SettingsValues = {
  editor: EditorSettings
  toolbar: ToolbarPreferences
  barSizes: InterfaceBarSizes
  statusBar: StatusBarPreferences
}

/** 設定履歴へ保存するスナップショットを複製し、参照共有を防ぐ。 */
export function cloneSettingsValues(value: SettingsValues): SettingsValues {
  return {
    editor: { ...value.editor },
    toolbar: {
      visible: value.toolbar.visible,
      items: value.toolbar.items.map((item) => ({ ...item })),
    },
    barSizes: cloneInterfaceBarSizes(value.barSizes),
    statusBar: cloneStatusBarPreferences(value.statusBar),
  }
}
