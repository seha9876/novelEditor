/** 永続データの実際の保存先をRust側の起動処理と共有する。 */

export type StorageStatus = {
  activeDirectory: string
  defaultDirectory: string
  pendingDirectory: string | null
  blockedReason: string | null
  cleanupPending: boolean
}

export type StorageFileName = 'preferences.json' | 'recovery.json'

let activeDirectory: string | null = null

/** 必要な操作時だけTauriのコマンド呼び出しを読み込む。 */
async function invokeStorage<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

/** 起動時にRustが確定した保存先を、各Storeより先に設定する。 */
export function setActiveStorageDirectory(directory: string): void {
  if (!directory.trim()) throw new Error('保存先のパスが空です。')
  activeDirectory = directory
}

/** Storeプラグインへ渡す保存ファイルの絶対パスを返す。 */
export function getStorageFilePath(fileName: StorageFileName): string {
  if (!activeDirectory) throw new Error('保存先が確定する前にデータStoreへアクセスしました。')
  const separator = activeDirectory.endsWith('\\') || activeDirectory.endsWith('/') ? '' : '\\'
  return `${activeDirectory}${separator}${fileName}`
}

/** Rust側の起動状態と、画面に表示する保存先を取得する。 */
export function getStorageStatus(): Promise<StorageStatus> {
  return invokeStorage('storage_status')
}

/** 選択された親フォルダへの移行を次回起動用に予約する。 */
export function scheduleStorageChange(parentDirectory: string): Promise<StorageStatus> {
  return invokeStorage('storage_schedule_change', { parentDirectory })
}

/** 既定の保存先を次回起動時の保存先として予約する。 */
export function scheduleDefaultStorage(): Promise<StorageStatus> {
  return invokeStorage('storage_schedule_default')
}

/** 既存データフォルダーへの切替を次回起動用に予約する。 */
export function scheduleExistingStorage(dataDirectory: string): Promise<StorageStatus> {
  return invokeStorage('storage_schedule_relink_existing', { dataDirectory })
}

/** 次回起動用に予約された保存先の変更を取り消す。 */
export function cancelStorageChange(): Promise<StorageStatus> {
  return invokeStorage('storage_cancel_change')
}

/** ブロックされた起動処理を再試行する。 */
export function retryStorageStartup(): Promise<StorageStatus> {
  return invokeStorage('storage_retry_startup')
}

/** 既存の実データフォルダを新しい保存先として登録し、起動処理を再試行する。 */
export function relinkExistingStorage(dataDirectory: string): Promise<StorageStatus> {
  return invokeStorage('storage_relink_existing', { dataDirectory })
}

/** 設定と復元Storeを読み込んだ後、移行元の片付けをRustへ確定する。 */
export function confirmStorageStartup(): Promise<StorageStatus> {
  return invokeStorage('storage_confirm_startup')
}

/** 旧保存先のファイルを残したまま、片付けの再試行予約だけを解除する。 */
export function abandonStorageCleanup(): Promise<StorageStatus> {
  return invokeStorage('storage_abandon_cleanup')
}
