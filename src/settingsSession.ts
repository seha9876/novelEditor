import type { EditorSettings } from './editorSettings'
import type { ToolbarItem, ToolbarPreferences } from './appPreferences'

/** 設定ウィンドウで表示するページを識別する。 */
export type SettingsPageId = 'editor.wrapping' | 'appearance.toolbar'

/** 設定ウィンドウへ配信する現在値と自動保存の状態。 */
export type SettingsSnapshot = {
  editor: EditorSettings
  toolbar: ToolbarPreferences
  page: SettingsPageId
  saveState: 'idle' | 'pending' | 'saving'
  revision: number
}

/** 設定ウィンドウからメイン画面へ送るページ移動と型付き部分更新。 */
export type SettingsCommand =
  | { type: 'ready' }
  | { type: 'navigate'; page: SettingsPageId }
  | {
      type: 'change'
      editor?: Partial<EditorSettings>
      toolbar?: Partial<ToolbarPreferences> & { items?: ToolbarItem[] }
      flush?: boolean
    }

export const SETTINGS_COMMAND_EVENT = 'editor-settings-command'
export const SETTINGS_STATE_EVENT = 'editor-settings-state'
export const SETTINGS_ERROR_EVENT = 'editor-settings-error'
