/** 本文・ツールバー・バーサイズを履歴用の独立した値として扱う。 */
import {
  cloneInterfaceBarSizes,
  type InterfaceBarSizes,
  type ToolbarPreferences,
} from './appPreferences'
import type { EditorSettings } from './editorSettings'

export type SettingsValues = {
  editor: EditorSettings
  toolbar: ToolbarPreferences
  barSizes: InterfaceBarSizes
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
  }
}
