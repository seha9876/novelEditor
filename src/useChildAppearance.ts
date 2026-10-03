/** 子窓の配色購読をVueのライフサイクルに合わせる。 */
import { onBeforeUnmount, onMounted } from 'vue'
import { createAppearanceClient } from './appearanceChannel'
import { applyAppearance } from './appearancePresentation'
import { createDefaultAppearance } from './appearance'

/** 接続失敗を診断ログへ残し、終了後に購読を残さない。 */
export function useChildAppearance(): void {
  applyAppearance(createDefaultAppearance().colors)
  const client = createAppearanceClient(applyAppearance)
  onMounted(() => {
    void client.setup().catch((error: unknown) => { console.error('配色の同期を開始できませんでした。', error) })
  })
  onBeforeUnmount(client.dispose)
}
