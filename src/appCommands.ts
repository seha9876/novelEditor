/** アプリ内で共通利用するコマンド識別子。 */
export type CommandId =
  | 'document.new'
  | 'document.open'
  | 'document.save'
  | 'settings.open'
  | 'wrap.window'
  | 'wrap.columns'
  | 'wrap.none'
  | 'window.minimize'
  | 'window.maximize'
  | 'window.maximizeVertical'
  | 'window.maximizeHorizontal'
  | 'window.alwaysOnTop'
  | 'window.close'
  | 'view.toolbar.toggle'
  | 'view.toolbar.customize'

/** メニューとツールバーが共有するコマンド表示情報。 */
export type AppCommandDefinition = {
  id: CommandId
  label: string
  icon?: string
  shortcut?: string
  toolbarEligible: boolean
}

/** 表示情報に実行処理と現在状態を結び付けた実行時コマンド。 */
export type AppCommand = AppCommandDefinition & {
  execute: () => Promise<void>
  isEnabled: () => boolean
  isChecked: () => boolean
}

/** コマンドの表示名とツールバー登録可否を一元管理する。 */
export const appCommandDefinitions: readonly AppCommandDefinition[] = [
  { id: 'document.new', label: '新規', icon: 'mdi-file-plus-outline', shortcut: 'Ctrl+N', toolbarEligible: true },
  { id: 'document.open', label: '開く', icon: 'mdi-folder-open-outline', shortcut: 'Ctrl+O', toolbarEligible: true },
  { id: 'document.save', label: '保存', icon: 'mdi-content-save-outline', shortcut: 'Ctrl+S', toolbarEligible: true },
  { id: 'settings.open', label: '設定画面を開く', icon: 'mdi-cog-outline', toolbarEligible: true },
  { id: 'wrap.window', label: '右端で折り返し', icon: 'mdi-wrap', toolbarEligible: true },
  { id: 'wrap.columns', label: '指定桁数で折り返し', icon: 'mdi-format-columns', toolbarEligible: true },
  { id: 'wrap.none', label: '折り返さない', icon: 'mdi-wrap-disabled', toolbarEligible: true },
  { id: 'window.minimize', label: '最小化', icon: 'mdi-window-minimize', toolbarEligible: true },
  { id: 'window.maximize', label: '最大化', icon: 'mdi-window-maximize', toolbarEligible: true },
  { id: 'window.maximizeVertical', label: '縦方向に最大化', icon: 'mdi-arrow-expand-vertical', toolbarEligible: true },
  { id: 'window.maximizeHorizontal', label: '横方向に最大化', icon: 'mdi-arrow-expand-horizontal', toolbarEligible: true },
  { id: 'window.alwaysOnTop', label: '常に手前に表示', icon: 'mdi-pin-outline', toolbarEligible: true },
  { id: 'window.close', label: '閉じる', icon: 'mdi-window-close', toolbarEligible: true },
  { id: 'view.toolbar.toggle', label: 'ツールバーを表示', icon: 'mdi-toolbar', toolbarEligible: false },
  { id: 'view.toolbar.customize', label: 'ツールバーをカスタマイズ', icon: 'mdi-tune-variant', toolbarEligible: false },
]

/** ツールバーに登録できるコマンドだけを返す。 */
export function getToolbarCommandDefinitions(): readonly AppCommandDefinition[] {
  return appCommandDefinitions.filter((command) => command.toolbarEligible)
}

/** 文字列が既知のコマンドIDか判定する。 */
export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && appCommandDefinitions.some((command) => command.id === value)
}
