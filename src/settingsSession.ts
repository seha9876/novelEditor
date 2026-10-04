import type { OutlinePreferences } from './outline'
import type { EditorSettings } from './editorSettings'
import type { AppearanceAction, AppearancePreferences, Palette } from './appearance'
import type { InterfaceBarSizes, StatusBarItemId, StatusBarPreferences, ToolbarItem, ToolbarPreferences } from './appPreferenceSchema'
import type { SettingsViewId } from './settingsDefinitions'

/** 設定ウィンドウへ配信する現在値とUndo／Redoの状態。 */
export type SettingsSnapshot = {
  appearance: AppearancePreferences
  appearanceFileBusy: boolean
  outline: OutlinePreferences
  editor: EditorSettings
  toolbar: ToolbarPreferences
  statusBar: StatusBarPreferences
  barSizes: InterfaceBarSizes
  page: SettingsViewId
  history: {
    canUndo: boolean
    canRedo: boolean
  }
  revision: number
  appearanceEpoch: number
}

/** 色だけの返信。プリセット一覧や本文設定は連続操作中に送り直さない。 */
export type SettingsColorState = {
  revision: number
  appearanceEpoch: number
  changes: Partial<Palette>
  history: SettingsSnapshot['history']
  input?: { interactionId: string; sequence: number }
}

/** 設定ウィンドウからメイン画面へ送る履歴操作、ページ移動、型付き部分更新。 */
export type SettingsCommand =
  | { type: 'appearance'; action: AppearanceAction; colorInput?: { epoch: number; sequence: number } }
  | { type: 'input-barrier'; requestId: string }
  | { type: 'inputs-flushed'; requestId: string; error?: string }
  | { type: 'appearance-file'; operation: 'import' | 'export'; presetId?: string }
  | { type: 'ready' }
  | { type: 'navigate'; page: SettingsViewId }
  | { type: 'undo' }
  | { type: 'redo' }
  | {
      type: 'change'
      outline?: OutlinePreferences
      editor?: Partial<EditorSettings>
      toolbar?: Partial<ToolbarPreferences> & { items?: ToolbarItem[] }
      statusBar?: Partial<StatusBarPreferences> & { items?: StatusBarItemId[] }
      barSizes?: Partial<InterfaceBarSizes>
      resetAppearance?: boolean
      flush?: boolean
    }

export const SETTINGS_COMMAND_EVENT = 'editor-settings-command'
export const SETTINGS_STATE_EVENT = 'editor-settings-state'
export const SETTINGS_ERROR_EVENT = 'editor-settings-error'
export const SETTINGS_COLOR_EVENT = 'editor-settings-color'
export const SETTINGS_INPUT_ACK_EVENT = 'editor-settings-input-ack'
export const SETTINGS_FLUSH_INPUTS_EVENT = 'editor-settings-flush-inputs'
