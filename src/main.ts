// Vue アプリを HTML のルート要素へ接続し、共通スタイルを読み込む。
import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { vuetify } from './vuetify'
import { initializeApplicationPreferences } from './appPreferences'
import { mountStorageStartup } from './storageStartup'
import {
  getStorageStatus,
  setActiveStorageDirectory,
  type StorageStatus,
} from './storageLocation'

/** Rustが確定した保存先をStoreへ設定してから、メイン画面を初期化する。 */
async function mountMainApplication(): Promise<void> {
  let status: StorageStatus | null = null
  try {
    status = await getStorageStatus()
    if (status.blockedReason) {
      mountStorageStartup(status, status.blockedReason)
      return
    }
    setActiveStorageDirectory(status.activeDirectory)
    const initialization = await initializeApplicationPreferences()
    createApp(App, {
      initialPreferences: initialization.preferences,
      persistenceState: initialization.persistenceState,
      persistenceError: initialization.error,
      storageInitializationReady: initialization.persistenceState === 'ready',
    }).use(vuetify).mount('#app')
  } catch (error) {
    mountStorageStartup(status, String(error))
  }
}

void mountMainApplication()
