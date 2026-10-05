/** メイン窓の既存ファイル権限を使い、検証済みのアウトライン設定を入出力する。 */
import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'
import { outlineExample, type OutlinePreset } from './outline'
import { exportOutlinePreset, importOutlinePreset } from './outlinePresets'

const filters = [{ name: 'アウトラインプリセット（JSON）', extensions: ['json'] }]

/** 取消・中止時は登録せず、構文とWorkerでの判定が成功した設定だけ返す。 */
export async function readOutlinePreset(signal?: AbortSignal): Promise<OutlinePreset | null> {
  const path = await open({ multiple: false, directory: false, filters })
  if (!path || signal?.aborted) return null
  const bytes = await readFile(path)
  if (signal?.aborted) return null
  const preset = importOutlinePreset(new TextDecoder('utf-8', { fatal: true }).decode(bytes), crypto.randomUUID())
  const { runSidebarAnalysis } = await import('./sidebarWorker')
  await runSidebarAnalysis({ kind: 'outline', text: outlineExample, preferences: { rules: preset.rules } }, signal)
  return signal?.aborted ? null : preset
}

/** 選択した保存済み設定をUTF-8 JSONへ出力する。取消時はファイルを作らない。 */
export async function writeOutlinePreset(preset: OutlinePreset): Promise<void> {
  const safeName = preset.name.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').replace(/[. ]+$/, '') || 'アウトライン'
  const text = exportOutlinePreset(preset)
  const path = await save({ defaultPath: `${safeName}.outline.json`, filters })
  if (path) await writeFile(path, new TextEncoder().encode(text))
}
