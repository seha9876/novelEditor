/** エディター設定と画面構成をStoreへ永続化する。 */
import { load, type Store } from '@tauri-apps/plugin-store'
import {
  SETTINGS_STORAGE_KEY,
  normalizeEditorSettings,
  type EditorSettings,
} from './editorSettings'
import { getStorageFilePath } from './storageLocation'
import {
  cloneApplicationPreferences,
  createDefaultApplicationPreferences,
  normalizeApplicationPreferences,
  normalizeInterfaceBarSizes,
  normalizeToolbarItems,
  type ApplicationPreferencesV1,
  type InterfaceBarSizes,
  type ProjectTreePreferences,
  type ToolbarPreferences,
} from './appPreferenceSchema'

export type PreferencesPersistenceState = 'ready' | 'recovered' | 'unavailable'

export type PreferencesInitialization = {
  preferences: ApplicationPreferencesV1
  persistenceState: PreferencesPersistenceState
  error?: string
}

const preferencesFileName = 'preferences.json'
const preferencesKey = 'applicationPreferences'

let store: Store | null = null
let latestPreferences = createDefaultApplicationPreferences()
let persistenceState: PreferencesPersistenceState = 'ready'
let pendingSave = Promise.resolve()

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
    return { preferences: cloneApplicationPreferences(latestPreferences), persistenceState }
  }

  try {
    await writePreferences(store, latestPreferences)
    if (stored === undefined) removeLegacyEditorSettings()
    persistenceState = 'ready'
    return { preferences: cloneApplicationPreferences(latestPreferences), persistenceState }
  } catch (error) {
    store = null
    persistenceState = 'unavailable'
    return {
      preferences: cloneApplicationPreferences(latestPreferences),
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
    return { preferences: cloneApplicationPreferences(latestPreferences), persistenceState, error: loadError }
  } catch (recoveryError) {
    store = null
    persistenceState = 'unavailable'
    return {
      preferences: cloneApplicationPreferences(latestPreferences),
      persistenceState,
      error: `${loadError}\n${String(recoveryError)}`,
    }
  }
}

/** 設定全体をStoreへ書き込み、ディスクへの保存完了を待つ。 */
async function writePreferences(targetStore: Store, preferences: ApplicationPreferencesV1): Promise<void> {
  await targetStore.set(preferencesKey, preferences)
  await targetStore.save()
}

/** エディター・ツールバー・バーサイズの現在値を一つのStore更新として保存する。 */
export function saveSettingsPreferences(
  editor: EditorSettings,
  toolbar: ToolbarPreferences,
  barSizes: InterfaceBarSizes,
): Promise<void> {
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
      const candidate = normalizeApplicationPreferences(update(cloneApplicationPreferences(latestPreferences)))
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
