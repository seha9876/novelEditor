// Vue アプリを HTML のルート要素へ接続し、共通スタイルを読み込む。
import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { vuetify } from './vuetify'

createApp(App).use(vuetify).mount('#app')
