// 分離したプロジェクトツリーをメイン画面と同じテーマで起動する。
import { createApp } from 'vue'
import ProjectTreeWindow from './ProjectTreeWindow.vue'
import './style.css'
import { vuetify } from './vuetify'

createApp(ProjectTreeWindow).use(vuetify).mount('#app')
