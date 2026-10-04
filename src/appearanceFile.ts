/** メイン窓の既存ファイル権限で配色プリセットを入出力する。 */
import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'
import { exportColorPreset, importColorPreset, type ColorPreset } from './appearance'

const filters = [{ name: '配色プリセット（JSON）', extensions: ['json'] }]

/** 選択したJSONを検証する。取消時は登録操作を発生させない。 */
export async function readColorPreset(): Promise<ColorPreset | null> {
  const path = await open({ multiple: false, directory: false, filters })
  if (!path) return null
  const bytes = await readFile(path)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return importColorPreset(text, crypto.randomUUID())
}

/** 選択された保存済み配色をUTF-8 JSONとして出力する。 */
export async function writeColorPreset(preset: ColorPreset): Promise<void> {
  const safeName = preset.name.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').replace(/[. ]+$/, '') || '配色'
  const path = await save({ defaultPath: `${safeName}.json`, filters })
  if (path) await writeFile(path, new TextEncoder().encode(exportColorPreset(preset)))
}
