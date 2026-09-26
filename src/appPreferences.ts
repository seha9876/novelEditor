/** エディター設定と画面構成をまとめて永続化する。 */
import { load, type Store } from '@tauri-apps/plugin-store'
import type { CommandId } from './appCommands'
import {
  SETTINGS_STORAGE_KEY,
  defaultEditorSettings,
  normalizeEditorSettings,
  type EditorSettings,
} from './editorSettings'
import { isCommandId, getToolbarCommandDefinitions } from './appCommands'
import { getStorageFilePath } from './storageLocation'

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

/** バーサイズごとの高さと内部コントロール寸法を一か所で管理する。 */
export const interfaceBarSizePresets = {
  small: {
    menu: { height: 40, controlHeight: 24, iconSize: 18, fontSize: '0.6875rem', titleFontSize: '0.75rem', secondaryFontSize: '0.6875rem', windowControlWidth: 40, buttonPadding: 8, padding: 4, gap: 1, titleGap: 6, titlePadding: 8 },
    toolbar: { height: 48, controlHeight: 32, buttonHeight: 32, buttonWidth: 32, adjustButtonWidth: 28, iconSize: 18, fontSize: '0.6875rem', inputFontSize: '0.75rem', labelFontSize: '0.6875rem', fontWidth: 124, numberWidth: 114, numberMenuWidth: 26, padding: 6, gap: 3, itemMargin: 1, dividerHeight: 20, dividerMargin: 3 },
    status: { height: 30, fontSize: '0.6875rem', gap: 12, padding: 8, buttonHeight: 24, buttonPadding: 8, buttonFontSize: '0.6875rem', buttonIconSize: 16 },
  },
  medium: {
    menu: { height: 48, controlHeight: 28, iconSize: 20, fontSize: '0.75rem', titleFontSize: '0.875rem', secondaryFontSize: '0.75rem', windowControlWidth: 46, buttonPadding: 12, padding: 8, gap: 2, titleGap: 8, titlePadding: 12 },
    toolbar: { height: 60, controlHeight: 36, buttonHeight: 40, buttonWidth: 40, adjustButtonWidth: 32, iconSize: 20, fontSize: '0.75rem', inputFontSize: '0.8rem', labelFontSize: '0.75rem', fontWidth: 136, numberWidth: 126, numberMenuWidth: 30, padding: 8, gap: 4, itemMargin: 2, dividerHeight: 24, dividerMargin: 4 },
    status: { height: 36, fontSize: '0.75rem', gap: 16, padding: 12, buttonHeight: 28, buttonPadding: 12, buttonFontSize: '0.75rem', buttonIconSize: 18 },
  },
  large: {
    menu: { height: 56, controlHeight: 36, iconSize: 24, fontSize: '0.875rem', titleFontSize: '1rem', secondaryFontSize: '0.8125rem', windowControlWidth: 54, buttonPadding: 16, padding: 12, gap: 3, titleGap: 10, titlePadding: 16 },
    toolbar: { height: 72, controlHeight: 44, buttonHeight: 48, buttonWidth: 48, adjustButtonWidth: 40, iconSize: 24, fontSize: '0.875rem', inputFontSize: '0.9rem', labelFontSize: '0.875rem', fontWidth: 148, numberWidth: 138, numberMenuWidth: 36, padding: 12, gap: 6, itemMargin: 3, dividerHeight: 32, dividerMargin: 5 },
    status: { height: 44, fontSize: '0.875rem', gap: 20, padding: 16, buttonHeight: 36, buttonPadding: 16, buttonFontSize: '0.875rem', buttonIconSize: 22 },
  },
} as const

const defaultInterfaceBarSizes: InterfaceBarSizes = { menu: 'medium', toolbar: 'medium', status: 'medium' }

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

export type PreferencesPersistenceState = 'ready' | 'recovered' | 'unavailable'

export type PreferencesInitialization = {
  preferences: ApplicationPreferencesV1
  persistenceState: PreferencesPersistenceState
  error?: string
}

const preferencesFileName = 'preferences.json'
const preferencesKey = 'applicationPreferences'
const defaultProjectTreeWidth = 280
const defaultToolbarItems: ToolbarItem[] = [
  { type: 'command', commandId: 'wrap.window' },
  { type: 'command', commandId: 'wrap.columns' },
  { type: 'command', commandId: 'wrap.none' },
  { type: 'separator', id: 'separator-1' },
  { type: 'command', commandId: 'settings.open' },
]

let store: Store | null = null
let latestPreferences = createDefaultApplicationPreferences()
let persistenceState: PreferencesPersistenceState = 'ready'
let pendingSave = Promise.resolve()

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

/** LocalStorageに残る旧エディター設定を安全に読み込む。 */
function loadLegacyEditorSettings(): EditorSettings | null {
  try {
    const legacyValue = localStorage.getItem(SETTINGS_STORAGE_KEY)
    return legacyValue ? normalizeEditorSettings(JSON.parse(legacyValue)) : null
  } catch {
    return null
  }
}

/** Storeへの保存完了後にだけ、移行済みの旧キーを削除する。 */
function removeLegacyEditorSettings(): void {
  try {
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
  } catch {
    // LocalStorage が使用できない環境では Store の設定をそのまま利用する。
  }
}

/** 初期設定をロードし、失敗時にも既定値で起動できる結果を返す。 */
export async function initializeApplicationPreferences(): Promise<PreferencesInitialization> {
  let stored: unknown
  try {
    store = await load(getStorageFilePath(preferencesFileName), { autoSave: false })
    stored = await store.get<unknown>(preferencesKey)
  } catch (error) {
    return recoverPreferences(String(error))
  }

  latestPreferences = stored === undefined ? createInitialPreferences() : normalizeApplicationPreferences(stored)
  if (stored !== undefined && JSON.stringify(stored) === JSON.stringify(latestPreferences)) {
    persistenceState = 'ready'
    return { preferences: clonePreferences(latestPreferences), persistenceState }
  }

  try {
    await writePreferences(store, latestPreferences)
    if (stored === undefined) removeLegacyEditorSettings()
    persistenceState = 'ready'
    return { preferences: clonePreferences(latestPreferences), persistenceState }
  } catch (error) {
    store = null
    persistenceState = 'unavailable'
    return {
      preferences: clonePreferences(latestPreferences),
      persistenceState,
      error: String(error),
    }
  }
}

/** 旧LocalStorage値があれば初期設定のエディター項目へ取り込む。 */
function createInitialPreferences(): ApplicationPreferencesV1 {
  const preferences = createDefaultApplicationPreferences()
  const legacySettings = loadLegacyEditorSettings()
  if (legacySettings) preferences.editor = legacySettings
  return preferences
}

/** Storeを再作成し、再構築可能な既定設定で起動する。 */
async function recoverPreferences(loadError: string): Promise<PreferencesInitialization> {
  latestPreferences = createDefaultApplicationPreferences()
  try {
    store = await load(getStorageFilePath(preferencesFileName), {
      autoSave: false,
      createNew: true,
      defaults: { [preferencesKey]: latestPreferences },
    })
    await writePreferences(store, latestPreferences)
    persistenceState = 'recovered'
    return { preferences: clonePreferences(latestPreferences), persistenceState, error: loadError }
  } catch (recoveryError) {
    store = null
    persistenceState = 'unavailable'
    return {
      preferences: clonePreferences(latestPreferences),
      persistenceState,
      error: `${loadError}\n${String(recoveryError)}`,
    }
  }
}

/** 設定全体を Store へ書き込み、ディスクへの保存完了を待つ。 */
async function writePreferences(targetStore: Store, preferences: ApplicationPreferencesV1): Promise<void> {
  await targetStore.set(preferencesKey, preferences)
  await targetStore.save()
}

/** エディター・ツールバー・バーサイズの現在値を一つのStore更新として保存する。 */
export function saveSettingsPreferences(editor: EditorSettings, toolbar: ToolbarPreferences, barSizes: InterfaceBarSizes): Promise<void> {
  return savePreferenceUpdate((current) => ({
    ...current,
    editor: normalizeEditorSettings(editor),
    ui: {
      ...current.ui,
      toolbar: {
        visible: toolbar.visible,
        items: normalizeToolbarItems(toolbar.items),
      },
      barSizes: normalizeInterfaceBarSizes(barSizes),
    },
  }))
}

/** ツリー幅とウィンドウ分離状態を既存の設定Storeへ保存する。 */
export function saveProjectTreePreferences(projectTree: ProjectTreePreferences): Promise<void> {
  return savePreferenceUpdate((current) => ({
    ...current,
    ui: {
      ...current.ui,
      projectTree: {
        width: Math.max(220, Math.min(480, Math.round(projectTree.width))),
        detached: projectTree.detached,
      },
    },
  }))
}

/** 最新の保存済み設定へ部分更新を直列適用し、成功後にメモリ状態を確定する。 */
function savePreferenceUpdate(update: (current: ApplicationPreferencesV1) => ApplicationPreferencesV1): Promise<void> {
  pendingSave = pendingSave.catch(() => undefined).then(async () => {
    try {
      const candidate = normalizeApplicationPreferences(update(clonePreferences(latestPreferences)))
      let targetStore = store
      if (!targetStore) {
        try {
          targetStore = await load(getStorageFilePath(preferencesFileName), { autoSave: false })
        } catch {
          targetStore = await load(getStorageFilePath(preferencesFileName), {
            autoSave: false,
            createNew: true,
            defaults: { [preferencesKey]: candidate },
          })
        }
      }
      await writePreferences(targetStore, candidate)
      store = targetStore
      latestPreferences = candidate
      persistenceState = 'ready'
    } catch (error) {
      store = null
      persistenceState = 'unavailable'
      throw error
    }
  })
  return pendingSave
}

/** 設定オブジェクトを複製し、Storeと画面の参照共有を避ける。 */
function clonePreferences(value: ApplicationPreferencesV1): ApplicationPreferencesV1 {
  return {
    schemaVersion: 1,
    editor: { ...value.editor },
    ui: {
      toolbar: {
        visible: value.ui.toolbar.visible,
        items: value.ui.toolbar.items.map((item) => ({ ...item })),
      },
      barSizes: { ...value.ui.barSizes },
      projectTree: { ...value.ui.projectTree },
    },
  }
}
