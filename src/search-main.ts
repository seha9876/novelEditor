// 検索・置換専用の子ウィンドウを共通テーマで起動する。
import { createApp } from 'vue'
import SearchApp from './SearchApp.vue'
import './search.css'
import { vuetify } from './vuetify'

createApp(SearchApp).use(vuetify).mount('#app')
