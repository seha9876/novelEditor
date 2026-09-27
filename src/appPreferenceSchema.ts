/** アプリ設定の保存形式、既定値、検証・複製処理をまとめる。 */
import type { CommandId } from './appCommands'
import { getToolbarCommandDefinitions, isCommandId } from './appCommands'
import {
  defaultEditorSettings,
  normalizeEditorSettings,
  type EditorSettings,
} from './editorSettings'

export type ToolbarItem =
  | { type: 'command'; commandId: CommandId }
  | { type: 'separator'; id: string }

export type ToolbarPreferences = {
  visible: boolean
  items: ToolbarItem[]
}

/** メニュー・ツール・ステータスバーへ適用する表示サイズの段階。 */
export type InterfaceSize = 'small' | 'medium' | 'large'

/** 各バーの表示サイズを個別に保持する。設定画面の選択値と保存値で共有する。 */
export type InterfaceBarSizes = {
  menu: InterfaceSize
  toolbar: InterfaceSize
  status: InterfaceSize
}

const defaultInterfaceBarSizes: InterfaceBarSizes = { menu: 'medium', toolbar: 'medium', status: 'medium' }
const defaultProjectTreeWidth = 280
const defaultToolbarItems: ToolbarItem[] = [
  { type: 'command', commandId: 'wrap.window' },
  { type: 'command', commandId: 'wrap.columns' },
  { type: 'command', commandId: 'wrap.none' },
  { type: 'separator', id: 'separator-1' },
  { type: 'command', commandId: 'settings.open' },
]

export type ProjectTreePreferences = {
  width: number
  detached: boolean
}

export type ApplicationPreferencesV1 = {
  schemaVersion: 1
  editor: EditorSettings
  ui: {
    toolbar: ToolbarPreferences
    barSizes: InterfaceBarSizes
    projectTree: ProjectTreePreferences
  }
}

/** 初期値を新しいオブジェクトとして返す。 */
export function createDefaultApplicationPreferences(): ApplicationPreferencesV1 {
  return {
    schemaVersion: 1,
    editor: { ...defaultEditorSettings },
    ui: {
      toolbar: {
        visible: true,
        items: createDefaultToolbarItems(),
      },
      barSizes: createDefaultInterfaceBarSizes(),
      projectTree: { width: defaultProjectTreeWidth, detached: false },
    },
  }
}

/** 既定の各バーサイズを独立したオブジェクトとして返す。 */
export function createDefaultInterfaceBarSizes(): InterfaceBarSizes {
  return { ...defaultInterfaceBarSizes }
}

/** バーサイズ設定を履歴や保存処理から独立した値として複製する。 */
export function cloneInterfaceBarSizes(value: InterfaceBarSizes): InterfaceBarSizes {
  return { menu: value.menu, toolbar: value.toolbar, status: value.status }
}

/** 全設定初期化で使う、各バーを中サイズへ戻した値を返す。 */
export function resetInterfaceBarSizes(): InterfaceBarSizes {
  return createDefaultInterfaceBarSizes()
}

/** ツールバーの表示状態を保ったまま、項目構成だけを初期値へ戻す。 */
export function resetToolbarPreferences(value: ToolbarPreferences): ToolbarPreferences {
  return { visible: value.visible, items: createDefaultToolbarItems() }
}

/** 文字列のバーサイズを検査し、不正値を中サイズへ補正する。 */
export function normalizeInterfaceSize(value: unknown): InterfaceSize {
  return value === 'small' || value === 'large' || value === 'medium' ? value : 'medium'
}

/** 保存データのバーサイズを項目ごとに検査し、欠損値も中サイズへ補完する。 */
export function normalizeInterfaceBarSizes(value: unknown): InterfaceBarSizes {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    menu: normalizeInterfaceSize(raw.menu),
    toolbar: normalizeInterfaceSize(raw.toolbar),
    status: normalizeInterfaceSize(raw.status),
  }
}

/** 既定ツールバー構成を独立した配列として返す。 */
export function createDefaultToolbarItems(): ToolbarItem[] {
  return defaultToolbarItems.map((item) => ({ ...item }))
}

/** ツールバー構成を検査し、利用者が配置したセパレーターの位置を保って返す。 */
export function normalizeToolbarItems(value: unknown): ToolbarItem[] {
  if (!Array.isArray(value)) return defaultToolbarItems.map((item) => ({ ...item }))
  if (value.length === 0) return []

  const availableCommandIds = new Set(getToolbarCommandDefinitions().map((command) => command.id))
  const seenCommands = new Set<string>()
  const seenSeparatorIds = new Set<string>()
  const normalized: ToolbarItem[] = []
  let separatorNumber = 0

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue
    const item = candidate as Record<string, unknown>
    if (item.type === 'command' && isCommandId(item.commandId) && availableCommandIds.has(item.commandId)) {
      if (seenCommands.has(item.commandId)) continue
      seenCommands.add(item.commandId)
      normalized.push({ type: 'command', commandId: item.commandId })
    } else if (item.type === 'separator') {
      let id = typeof item.id === 'string' && item.id.length > 0 ? item.id : ''
      if (!id || seenSeparatorIds.has(id)) {
        do {
          separatorNumber += 1
          id = `separator-${separatorNumber}`
        } while (seenSeparatorIds.has(id))
      }
      seenSeparatorIds.add(id)
      normalized.push({ type: 'separator', id })
    }
  }

  return normalized.length > 0 ? normalized : createDefaultToolbarItems()
}

/** 外部データをセクション単位で検査し、利用可能な設定へ正規化する。 */
export function normalizeApplicationPreferences(value: unknown): ApplicationPreferencesV1 {
  if (!value || typeof value !== 'object') return createDefaultApplicationPreferences()
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) return createDefaultApplicationPreferences()
  const rawUi = raw.ui && typeof raw.ui === 'object' ? raw.ui as Record<string, unknown> : {}
  const rawToolbar = rawUi.toolbar && typeof rawUi.toolbar === 'object'
    ? rawUi.toolbar as Record<string, unknown>
    : {}
  const rawProjectTree = rawUi.projectTree && typeof rawUi.projectTree === 'object'
    ? rawUi.projectTree as Record<string, unknown>
    : {}
  const rawBarSizes = rawUi.barSizes && typeof rawUi.barSizes === 'object'
    ? rawUi.barSizes
    : undefined
  const projectTreeWidth = typeof rawProjectTree.width === 'number' && Number.isFinite(rawProjectTree.width)
    ? Math.round(rawProjectTree.width)
    : defaultProjectTreeWidth
  return {
    schemaVersion: 1,
    editor: normalizeEditorSettings(raw.editor),
    ui: {
      toolbar: {
        visible: typeof rawToolbar.visible === 'boolean' ? rawToolbar.visible : true,
        items: normalizeToolbarItems(rawToolbar.items),
      },
      barSizes: normalizeInterfaceBarSizes(rawBarSizes),
      projectTree: {
        width: Math.max(220, Math.min(480, projectTreeWidth)),
        detached: typeof rawProjectTree.detached === 'boolean' ? rawProjectTree.detached : false,
      },
    },
  }
}

/** 設定オブジェクトを複製し、Storeと画面の参照共有を避ける。 */
export function cloneApplicationPreferences(value: ApplicationPreferencesV1): ApplicationPreferencesV1 {
  return {
    schemaVersion: 1,
    editor: { ...value.editor },
    ui: {
      toolbar: {
        visible: value.ui.toolbar.visible,
        items: value.ui.toolbar.items.map((item) => ({ ...item })),
      },
      barSizes: cloneInterfaceBarSizes(value.ui.barSizes),
      projectTree: { ...value.ui.projectTree },
    },
  }
}
