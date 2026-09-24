/** 未保存本文の復元候補を、設定とは独立した単一世代のStoreへ保存する。 */
import { load, type Store } from '@tauri-apps/plugin-store'
import { exists } from '@tauri-apps/plugin-fs'
import { fileName, type LineEnding } from './textFile'
import { getStorageFilePath } from './storageLocation'

export type RecoverySnapshotV1 = {
  schemaVersion: 1
  text: string
  fileName: string
  lineEnding: LineEnding
  hasBom: boolean
  updatedAt: string
}

const recoveryFileName = 'recovery.json'
const recoveryKey = 'snapshot'
let store: Store | undefined
let pendingOperation: Promise<unknown> = Promise.resolve()

/** 読み込み・保存・削除を要求順に実行し、失敗後も次の操作を受け付ける。 */
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = pendingOperation.catch(() => undefined).then(operation)
  pendingOperation = next
  return next
}

/** 復元対象の形式を厳密に検査し、保存先のパスを含まないデータだけを返す。 */
export function parseRecoverySnapshot(value: unknown): RecoverySnapshotV1 {
  if (!value || typeof value !== 'object') throw new Error('復元データの形式が不正です。')
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1 || typeof raw.text !== 'string' ||
    typeof raw.fileName !== 'string' || !raw.fileName || /[\\/\0]/.test(raw.fileName) ||
    !['\n', '\r\n', '\r'].includes(raw.lineEnding as string) || typeof raw.hasBom !== 'boolean' ||
    typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) {
    throw new Error('復元データが破損しているか、対応していない形式です。')
  }
  return {
    schemaVersion: 1,
    text: raw.text,
    fileName: fileName(raw.fileName),
    lineEnding: raw.lineEnding as LineEnding,
    hasBom: raw.hasBom,
    updatedAt: raw.updatedAt,
  }
}

/** 既存ファイルを再読込して実エラーを検出する。失敗したStoreは閉じ、終了時の空データ上書きを防ぐ。 */
export function loadRecoverySnapshot(): Promise<RecoverySnapshotV1 | null> {
  return enqueue(async () => {
    let targetStore: Store | undefined
    try {
      // load()はファイル不在だけでなく読込エラーも空Storeへ変えるため、既存ファイルはreloadで検証する。
      const recoveryFile = getStorageFilePath(recoveryFileName)
      if (!await exists(recoveryFile)) return null
      targetStore = await load(recoveryFile, { autoSave: false })
      await targetStore.reload({ ignoreDefaults: true })
      const value = await targetStore.get<unknown>(recoveryKey)
      const snapshot = value === undefined || value === null ? null : parseRecoverySnapshot(value)
      store = targetStore
      return snapshot
    } catch (error) {
      store = undefined
      // autoSave:falseでもアプリ終了時には保存される。読めなかった候補はresource登録ごと解除して残す。
      if (targetStore) await targetStore.close()
      throw error
    }
  })
}

/** 最新の復元候補を保存する。null は明示保存・破棄済み候補の削除を表す。 */
export function saveRecoverySnapshot(snapshot: RecoverySnapshotV1 | null): Promise<void> {
  // 呼び出し後に外部から変更されても、直列キューへ入れた内容を変えない。
  const candidate = snapshot ? parseRecoverySnapshot(snapshot) : null
  return enqueue(async () => {
    if (!store) {
      // 初回起動や読込失敗後の正常終了では、新たな空Storeを作らず既存ファイルをそのまま残す。
      if (!candidate) return
      // 読込失敗を通知した候補は、新しい本文を保護する要求が来てから置き換える。
      store = await load(getStorageFilePath(recoveryFileName), { autoSave: false, createNew: true })
    }
    if (candidate) await store.set(recoveryKey, candidate)
    else await store.delete(recoveryKey)
    await store.save()
  })
}
