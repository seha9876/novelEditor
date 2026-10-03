/** ファイル履歴の型と、メイン窓から利用するTauri APIをまとめる。 */
import { invoke } from '@tauri-apps/api/core'

export type RecentFile = { id: number; path: string }

/** 保存済みの最新20件を新しい順で取得する。 */
export function listRecentFiles(): Promise<RecentFile[]> {
  return invoke('recent_files_list')
}

/** 読込・保存に成功したファイルを記録する。許可範囲の検証はRust側で行う。 */
export function recordRecentFile(path: string): Promise<void> {
  return invoke('recent_file_record', { path })
}

/** 履歴項目だけを削除し、実ファイルは残す。 */
export function removeRecentFile(id: number): Promise<void> {
  return invoke('recent_files_remove', { id })
}

/** 確認済みの全履歴消去をメイン側から要求する。 */
export function clearRecentFiles(): Promise<void> {
  return invoke('recent_files_clear')
}

/** 保存済みIDから再検証したファイルの許可済みパスを取得する。 */
export function authorizeRecentFile(id: number): Promise<string> {
  return invoke('recent_file_authorize', { id })
}

/** Windowsの拡張パス表記・区切り・大小文字を揃え、開いている原稿の再読込を避ける。 */
export function sameRecentFilePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right)
}

/** 通常のドライブパスとUNCパスを、比較専用の表記に揃える。 */
function comparablePath(path: string): string {
  return path.replace(/\//g, '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').toLowerCase()
}
