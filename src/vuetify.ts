// メイン画面と設定画面で共有する Vuetify のテーマ・ロケール・アイコンを初期化する。
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import '@mdi/font/css/materialdesignicons.css'
import 'vuetify/styles'
import { createVuetify } from 'vuetify'
import { aliases, mdi } from 'vuetify/iconsets/mdi'
import { ja } from 'vuetify/locale'

/** 小説エディタ全体で使う Vuetify プラグインを作成する。標準ライトテーマを基準にする。 */
export const vuetify = createVuetify({
  icons: {
    defaultSet: 'mdi',
    aliases,
    sets: { mdi },
  },
  locale: {
    locale: 'ja',
    fallback: 'en',
    messages: { ja },
  },
  theme: {
    defaultTheme: 'light',
  },
})
