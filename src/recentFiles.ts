/** ファイル履歴の型と、メイン窓から利用するTauri APIをまとめる。 */
import { invoke } from '@tauri-apps/api/core'
import type { EditorPosition } from './editorNavigation'

export type RecentFile = { id: number; path: string; position?: EditorPosition | null }

/** 保存済みの最新20件を新しい順で取得する。 */
export function listRecentFiles(): Promise<RecentFile[]> {
  return invoke('recent_files_list')
}

/** 読込・保存に成功したファイルを記録し、同じ履歴IDと前回の位置を返す。 */
export function recordRecentFile(path: string): Promise<RecentFile> {
  return invoke('recent_file_record', { path })
}

/** 履歴順を変えずに位置だけを更新する。削除済みの履歴は再作成しない。 */
export function updateRecentFilePosition(id: number, position: EditorPosition): Promise<void> {
  return invoke('recent_file_position_update', { id, position })
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
export function comparablePath(path: string): string {
  return path.replace(/\//g, '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').toLowerCase()
}
