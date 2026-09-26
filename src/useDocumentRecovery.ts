/** 未保存本文の復旧候補と遅延保存を文書状態から分離する。 */
import { ask } from '@tauri-apps/plugin-dialog'
import { loadRecoverySnapshot, saveRecoverySnapshot, type RecoverySnapshotV1 } from './recoveryStore'

type DocumentRecoveryOptions = {
  getSnapshot: () => RecoverySnapshotV1 | null
  applySnapshot: (snapshot: RecoverySnapshotV1) => void
  onInitializationFinished: () => void
  focusEditor: () => void
  showPersistenceNotice: (text: string) => void
}

/** 復旧Storeを直列利用し、遅着処理が破棄後の文書へ触れないようにする。 */
export function useDocumentRecovery(options: DocumentRecoveryOptions) {
  let recoveryReady = false
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
  let recoveryErrorReported = false
  let disposed = false

  /** 古い本文に対する遅延処理を取り消し、文書切り替え後の復元候補復活を防ぐ。 */
  function cancelScheduledSave(): void {
    if (recoveryTimer) clearTimeout(recoveryTimer)
    recoveryTimer = undefined
  }

  /** 現在の未保存本文、または候補の削除をStoreへ渡す。失敗は編集を妨げず通知する。 */
  async function syncSnapshot(): Promise<void> {
    if (!recoveryReady || disposed) return
    cancelScheduledSave()
    try {
      await saveRecoverySnapshot(options.getSnapshot())
      if (disposed) return
      recoveryErrorReported = false
    } catch (error) {
      if (disposed) return
      if (!recoveryErrorReported) {
        options.showPersistenceNotice(`復元データを更新できません。本文を通常の保存で保護してください。${String(error)}`)
        recoveryErrorReported = true
      }
    }
  }

  /** 入力が1秒止まった時点で最新本文を保護し、保存済みに戻った場合は候補を削除する。 */
  function scheduleSave(): void {
    if (!recoveryReady || disposed) return
    cancelScheduledSave()
    if (!options.getSnapshot()) {
      void syncSnapshot()
      return
    }
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined
      void syncSnapshot()
    }, 1000)
  }

  /** 復元候補を確認し、適用結果を文書側へ渡す。 */
  async function initialize(): Promise<boolean> {
    if (disposed) return false
    let unresolvedSnapshot = false
    let recoveryLoaded = false
    try {
      const snapshot = await loadRecoverySnapshot()
      if (disposed) return false
      recoveryLoaded = true
      if (snapshot) {
        unresolvedSnapshot = true
        const restore = await ask(`前回の未保存の本文があります。復元しますか？\n${snapshot.fileName}\n${new Date(snapshot.updatedAt).toLocaleString('ja-JP')}`, {
          title: '本文の復元',
          kind: 'warning',
          okLabel: '復元',
          cancelLabel: '破棄',
        })
        if (disposed) return false
        unresolvedSnapshot = false
        if (restore) {
          options.applySnapshot(snapshot)
        } else {
          await saveRecoverySnapshot(null)
          if (disposed) return false
        }
      }
    } catch (error) {
      if (disposed) return false
      options.showPersistenceNotice(unresolvedSnapshot
        ? `復元の確認ができませんでした。前回の候補を保護するため、今回は復元データの自動保存を停止します。${String(error)}`
        : `復元データを読み込めませんでした。${String(error)}`)
    } finally {
      if (!disposed) {
        recoveryReady = !unresolvedSnapshot
        options.onInitializationFinished()
        options.focusEditor()
      }
    }
    return recoveryLoaded
  }

  /** 保存済み復元候補を明示的に削除する。終了処理では自動保存より後に呼び出す。 */
  async function clear(): Promise<void> {
    if (disposed || !recoveryReady) return
    await saveRecoverySnapshot(null)
  }

  /** 終了処理が取り消された場合に復元保存を再開する。 */
  function resume(): void {
    scheduleSave()
  }

  /** 終了前に遅延中の復元保存だけを取り消す。 */
  function flush(): void {
    cancelScheduledSave()
  }

  /** 復元タイマーとStoreへの遅着通知を破棄する。 */
  function dispose(): void {
    disposed = true
    cancelScheduledSave()
    recoveryReady = false
  }

  return {
    scheduleSave,
    syncSnapshot,
    initialize,
    clear,
    resume,
    flush,
    dispose,
  }
}
