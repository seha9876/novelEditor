// 設定ウィンドウ専用の画面を起動する。
import { createApp } from 'vue'
import SettingsApp from './SettingsApp.vue'
import './settings.css'
import { vuetify } from './vuetify'

createApp(SettingsApp).use(vuetify).mount('#app')
