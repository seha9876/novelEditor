// 保存先エラー時の起動画面をメイン画面から分離する。
import { createApp } from 'vue'
import StorageStartup from './StorageStartup.vue'
import { vuetify } from './vuetify'
import type { StorageStatus } from './storageLocation'

/** 保存先を利用できない場合に通常の初期化を止める画面を表示する。 */
export function mountStorageStartup(status: StorageStatus | null, error?: string): void {
  createApp(StorageStartup, { initialStatus: status, initialError: error }).use(vuetify).mount('#app')
}
