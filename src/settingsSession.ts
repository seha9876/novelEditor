import type { EditorSettings } from './editorSettings'
import type { ToolbarItem, ToolbarPreferences } from './appPreferences'

/** 設定ウィンドウで表示するページを識別する。 */
export type SettingsPageId = 'editor.wrapping' | 'appearance.toolbar'

/** 設定ウィンドウとメイン画面で共有する保存値・編集中の値。 */
export type SettingsSnapshot = {
  saved: EditorSettings
  draft: EditorSettings
  savedToolbar: ToolbarPreferences
  draftToolbar: ToolbarPreferences
  page: SettingsPageId
}

/** 設定ウィンドウからメイン画面へ送る変更・操作。 */
export type SettingsCommand =
  | { type: 'ready' }
  | { type: 'navigate'; page: SettingsPageId }
  | { type: 'change-editor'; value: Partial<EditorSettings> }
  | { type: 'change-toolbar'; value: { visible?: boolean; items?: ToolbarItem[] } }
  | { type: 'save' }
  | { type: 'cancel' }

export const SETTINGS_COMMAND_EVENT = 'editor-settings-command'
export const SETTINGS_STATE_EVENT = 'editor-settings-state'
export const SETTINGS_SAVED_EVENT = 'editor-settings-saved'
export const SETTINGS_ERROR_EVENT = 'editor-settings-error'
