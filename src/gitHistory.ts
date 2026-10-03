/** Git の履歴画面と Rust が共有する、操作対象を限定した型付き境界。 */
import { invoke } from '@tauri-apps/api/core'

export type GitWorkspace = { id: number; root: string; backup: string | null; authorName: string; authorEmail: string }
export type GitChange = { path: string; kind: 'added' | 'modified' | 'deleted' }
export type GitStatus = { branch: string; head: string; changes: GitChange[]; token: string; blocked: string | null; authorName: string; authorEmail: string; backupState: string }
export type GitEntry = { id: string; date: string; author: string; message: string }
export type GitList = { workspaces: GitWorkspace[]; version: string | null; error: string | null }
export type GitRequest =
  | { kind: 'list' }
  | { kind: 'inspect'; path: string }
  | { kind: 'register'; path: string; expectedRoot: string }
  | { kind: 'remove' | 'status'; id: number }
  | { kind: 'record'; id: number; token: string; paths: string[]; message: string; authorName: string; authorEmail: string }
  | { kind: 'history'; id: number; offset: number }
  | { kind: 'files'; id: number; commit: string }
  | { kind: 'blob'; id: number; commit: string; path: string }
  | { kind: 'export'; id: number; commit: string; path: string; destination: string }
  | { kind: 'setBackup'; id: number; path: string }
  | { kind: 'backup'; id: number; token: string }
  | { kind: 'branches'; path: string }
  | { kind: 'restore'; path: string; parent: string; name: string; branch: string }

/** 任意コマンドの実行を公開せず、定義済みの履歴操作だけを依頼する。 */
export function gitHistory<T>(request: GitRequest): Promise<T> { return invoke<T>('git_history', { request }) }

/** Windows の区切り・大文字小文字・拡張長接頭辞を揃え、現在原稿の所属を判断する。 */
export function isInsideGitWorkspace(path: string | null, root: string): boolean {
  if (!path) return false
  const normalized = normalizeGitPath(path)
  return normalized.startsWith(`${normalizeGitPath(root).replace(/\/$/, '')}/`)
}

/** 表示パスとTauriの拡張長パスを同じ形式に揃える。 */
function normalizeGitPath(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replace(/\\/g, '/').toLowerCase()
}
