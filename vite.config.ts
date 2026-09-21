// Vue の開発サーバー設定。Tauri の Rust 成果物は監視対象から外す。
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'

export default defineConfig({
  plugins: [
    vue(),
    // Vuetify のコンポーネントとディレクティブをテンプレートから自動登録する。
    vuetify({ autoImport: true }),
  ],
  build: {
    rollupOptions: {
      input: ['index.html', 'settings.html'],
    },
  },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
})
