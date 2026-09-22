import type { EditorSettings } from './editorSettings'
import type { ToolbarItem, ToolbarPreferences } from './appPreferences'
import type { SettingsViewId } from './settingsDefinitions'

/** 設定ウィンドウへ配信する現在値とUndo／Redoの状態。 */
export type SettingsSnapshot = {
  editor: EditorSettings
  toolbar: ToolbarPreferences
  page: SettingsViewId
  history: {
    canUndo: boolean
    canRedo: boolean
  }
  revision: number
}

/** 設定ウィンドウからメイン画面へ送る履歴操作、ページ移動、型付き部分更新。 */
export type SettingsCommand =
  | { type: 'ready' }
  | { type: 'navigate'; page: SettingsViewId }
  | { type: 'undo' }
  | { type: 'redo' }
  | {
      type: 'change'
      editor?: Partial<EditorSettings>
      toolbar?: Partial<ToolbarPreferences> & { items?: ToolbarItem[] }
      flush?: boolean
    }

export const SETTINGS_COMMAND_EVENT = 'editor-settings-command'
export const SETTINGS_STATE_EVENT = 'editor-settings-state'
export const SETTINGS_ERROR_EVENT = 'editor-settings-error'
