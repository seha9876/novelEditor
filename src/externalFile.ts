/** 外部更新の比較と、Rust側の条件付き保存との型付き境界。 */
import { invoke } from '@tauri-apps/api/core'

export type DiskState = { kind: 'present'; bytes: number[] } | { kind: 'missing' }
export type DiskObservation = DiskState | { kind: 'error'; message: string }
export type ExternalFileState = 'unchanged' | 'changed' | 'missing' | 'error'
export type FileConflict = { path: string; disk: DiskObservation }
export type ConditionalSaveResult = { kind: 'saved' } | { kind: 'conflict'; disk: DiskState }

/** 読取失敗を欠落と混同せず、通知に使える状態へ変換する。 */
export async function inspectTextFile(path: string): Promise<DiskObservation> {
  try { return await invoke<DiskState>('text_file_inspect', { path }) }
  catch (error) { return { kind: 'error', message: String(error) } }
}

/** バイト単位でBOM・改行も比較し、同じ内容の再保存は変更扱いにしない。 */
export function classifyExternalFile(disk: DiskObservation, baseline: Uint8Array): ExternalFileState {
  if (disk.kind !== 'present') return disk.kind
  return disk.bytes.length === baseline.length && disk.bytes.every((byte, index) => byte === baseline[index]) ? 'unchanged' : 'changed'
}

/** 検査と書込を一つのネイティブ操作にし、確認後の再変更でも無条件に上書きしない。 */
export function writeTextFileConditional(path: string, expected: DiskState, bytes: Uint8Array): Promise<ConditionalSaveResult> {
  return invoke('text_file_save_conditional', { path, expected, bytes: Array.from(bytes) })
}
