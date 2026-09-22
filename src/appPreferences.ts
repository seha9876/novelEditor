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

export type ToolbarItem =
  | { type: 'command'; commandId: CommandId }
  | { type: 'separator'; id: string }

export type ToolbarPreferences = {
  visible: boolean
  items: ToolbarItem[]
}

export type ApplicationPreferencesV1 = {
  schemaVersion: 1
  editor: EditorSettings
  ui: {
    toolbar: ToolbarPreferences
  }
}

export type PreferencesPersistenceState = 'ready' | 'recovered' | 'unavailable'

export type PreferencesInitialization = {
  preferences: ApplicationPreferencesV1
  persistenceState: PreferencesPersistenceState
  error?: string
}

const preferencesFile = 'preferences.json'
const preferencesKey = 'applicationPreferences'
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
    },
  }
}

/** 既定ツールバー構成を独立した配列として返す。 */
export function createDefaultToolbarItems(): ToolbarItem[] {
  return defaultToolbarItems.map((item) => ({ ...item }))
}

/** 保存されたツールバー構成を検査し、不正な項目を除いて返す。 */
export function normalizeToolbarItems(value: unknown): ToolbarItem[] {
  if (!Array.isArray(value)) return defaultToolbarItems.map((item) => ({ ...item }))
  if (value.length === 0) return []

  const availableCommandIds = new Set(getToolbarCommandDefinitions().map((command) => command.id))
  const seenCommands = new Set<string>()
  const normalized: ToolbarItem[] = []
  let separatorNumber = 0

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue
    const item = candidate as Record<string, unknown>
    if (item.type === 'command' && isCommandId(item.commandId) && availableCommandIds.has(item.commandId)) {
      if (seenCommands.has(item.commandId)) continue
      seenCommands.add(item.commandId)
      normalized.push({ type: 'command', commandId: item.commandId })
    } else if (item.type === 'separator' && normalized.at(-1)?.type !== 'separator') {
      separatorNumber += 1
      normalized.push({ type: 'separator', id: `separator-${separatorNumber}` })
    }
  }

  if (normalized[0]?.type === 'separator') normalized.shift()
  if (normalized.at(-1)?.type === 'separator') normalized.pop()
  return normalized.length > 0 ? normalized : createDefaultToolbarItems()
}

/** ツールバー編集中の項目を検査し、配置途中のセパレーターはそのまま保持する。 */
export function normalizeToolbarDraftItems(value: unknown): ToolbarItem[] {
  if (!Array.isArray(value)) return []

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

  return normalized
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
  return {
    schemaVersion: 1,
    editor: normalizeEditorSettings(raw.editor),
    ui: {
      toolbar: {
        visible: typeof rawToolbar.visible === 'boolean' ? rawToolbar.visible : true,
        items: normalizeToolbarItems(rawToolbar.items),
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
    store = await load(preferencesFile, { autoSave: false })
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
    store = await load(preferencesFile, {
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

/** エディターとツールバーの設定を一つの更新として保存する。 */
export function saveSettingsPreferences(editor: EditorSettings, toolbar: ToolbarPreferences): Promise<void> {
  return savePreferenceUpdate((current) => ({
    ...current,
    editor: normalizeEditorSettings(editor),
    ui: {
      ...current.ui,
      toolbar: {
        visible: toolbar.visible,
        items: normalizeToolbarItems(toolbar.items),
      },
    },
  }))
}

/** ツールバーの表示状態だけを最新設定へ反映し、構成を保って保存する。 */
export function saveToolbarVisibility(visible: boolean): Promise<void> {
  return savePreferenceUpdate((current) => ({
    ...current,
    ui: { ...current.ui, toolbar: { ...current.ui.toolbar, visible } },
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
          targetStore = await load(preferencesFile, { autoSave: false })
        } catch {
          targetStore = await load(preferencesFile, {
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
    },
  }
}
