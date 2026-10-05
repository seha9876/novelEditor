/** 子窓の配色購読をVueのライフサイクルに合わせる。 */
import { onBeforeUnmount, onMounted } from 'vue'
import { createAppearanceClient } from './appearanceChannel'
import { applyAppearance } from './appearancePresentation'
import { createDefaultAppearance } from './appearance'
import { createAppearanceTargetClient } from './appearanceTargetChannel'
import { createAppearanceTargetOverlay } from './appearanceTargetOverlay'

/** 接続失敗を診断ログへ残し、終了後に購読を残さない。 */
export function useChildAppearance(): void {
  applyAppearance(createDefaultAppearance().colors)
  const client = createAppearanceClient(applyAppearance)
  const overlay = createAppearanceTargetOverlay()
  const targetClient = createAppearanceTargetClient(overlay.update)
  onMounted(() => {
    void client.setup().catch((error: unknown) => { console.error('配色の同期を開始できませんでした。', error) })
    void targetClient.setup().catch((error: unknown) => { console.error('配色の対象表示を同期できませんでした。', error) })
  })
  onBeforeUnmount(() => { client.dispose(); targetClient.dispose(); overlay.dispose() })
}
