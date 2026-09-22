// Vue アプリを HTML のルート要素へ接続し、共通スタイルを読み込む。
import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { vuetify } from './vuetify'
import { initializeApplicationPreferences } from './appPreferences'

/** 永続設定を初期化してからメイン画面を表示する。 */
async function mountMainApplication(): Promise<void> {
  const initialization = await initializeApplicationPreferences()
  createApp(App, {
    initialPreferences: initialization.preferences,
    persistenceState: initialization.persistenceState,
    persistenceError: initialization.error,
  }).use(vuetify).mount('#app')
}

void mountMainApplication()
