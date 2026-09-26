/** 設定Storeへのデバウンス保存、直列化、失敗時のロールバックを管理する。 */

type SettingsPersistenceOptions<T> = {
  clone: (value: T) => T
  getSnapshot: () => T
  save: (snapshot: T) => Promise<void>
  applyRollback: (snapshot: T) => void
  notifyRollback: (error: unknown) => void
  notifyUnexpectedError: (error: unknown) => void
  publishState: () => Promise<void>
  debounceMs?: number
}

/** 設定変更を保存順に処理し、保存中の追加入力も最後の値まで反映する。 */
export function useSettingsPersistence<T>(options: SettingsPersistenceOptions<T>) {
  const debounceMs = options.debounceMs ?? 250
  let disposed = false
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let savePromise: Promise<void> | null = null
  let flushAfterCurrentSave = false
  let trailingSaveDue = false
  let changeRevision = 0
  let persistedRevision = 0
  let lastPersisted = options.clone(options.getSnapshot())

  /** 破棄されていない間だけ設定画面へ状態を配信する。 */
  async function publishState(): Promise<void> {
    if (!disposed) await options.publishState()
  }

  /** 保存成功した設定値を次回ロールバックの基準として保持する。 */
  function rememberPersisted(snapshot: T, revision: number): void {
    lastPersisted = options.clone(snapshot)
    persistedRevision = revision
  }

  /** 保存失敗時に直近の保存値へ戻し、再保存要求が残らないようにする。 */
  function rollback(error: unknown): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = undefined
    changeRevision += 1
    persistedRevision = changeRevision
    flushAfterCurrentSave = false
    trailingSaveDue = false
    if (disposed) return
    options.applyRollback(options.clone(lastPersisted))
    options.notifyRollback(error)
    void publishState()
  }

  /** Storeへの1回の書き込みを実行し、失敗をロールバックへ変換する。 */
  async function runSaveCycle(snapshot: T, revision: number): Promise<void> {
    try {
      await publishState()
      await options.save(snapshot)
      rememberPersisted(snapshot, revision)
      await publishState()
    } catch (error) {
      rollback(error)
    }
  }

  /** 現在値を保存し、保存中の変更は即時要求の有無に応じて続けて処理する。 */
  async function runSaveSequence(immediate: boolean): Promise<void> {
    let flushImmediately = immediate
    while (changeRevision > persistedRevision) {
      const writeRevision = changeRevision
      const writeSnapshot = options.clone(options.getSnapshot())
      await runSaveCycle(writeSnapshot, writeRevision)
      const hasNewerChanges = changeRevision > persistedRevision

      if (!hasNewerChanges) {
        flushAfterCurrentSave = false
        trailingSaveDue = false
        await publishState()
        return
      }

      await publishState()
      if (flushAfterCurrentSave || (flushImmediately && trailingSaveDue)) {
        flushAfterCurrentSave = false
        trailingSaveDue = false
        flushImmediately = true
        continue
      }

      flushAfterCurrentSave = false
      trailingSaveDue = false
      if (!saveTimer) scheduleSave()
      return
    }

    flushAfterCurrentSave = false
    trailingSaveDue = false
    await publishState()
  }

  /** 250ms後に保存を開始し、設定画面の状態も同時に更新する。 */
  function scheduleSave(): void {
    if (disposed) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      requestFlush()
    }, debounceMs)
    void publishState()
  }

  /** 設定値の変更を保存対象として登録する。 */
  function markChanged(): void {
    if (disposed) return
    changeRevision += 1
    scheduleSave()
  }

  /** 保存要求を未処理Promiseにせず開始する。 */
  function requestFlush(immediate = false): void {
    void flushOnce(immediate).catch((error: unknown) => {
      if (!disposed) options.notifyUnexpectedError(error)
    })
  }

  /** タイマーと既存保存を調整し、1回の保存要求を完了させる。 */
  async function flushOnce(immediate = false): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }

    if (savePromise) {
      if (immediate) flushAfterCurrentSave = true
      else trailingSaveDue = true
      await savePromise
      return
    }

    if (changeRevision <= persistedRevision) {
      await publishState()
      return
    }

    const currentSave = runSaveSequence(immediate)
    savePromise = currentSave
    try {
      await currentSave
    } finally {
      if (savePromise === currentSave) savePromise = null
    }
  }

  /** 終了前にデバウンス中・保存中の変更をすべて完了させる。 */
  async function flush(): Promise<void> {
    while (hasPending()) await flushOnce(true)
  }

  /** 保存中または保存待ちの変更があるかを返す。 */
  function hasPending(): boolean {
    return Boolean(saveTimer || savePromise || changeRevision > persistedRevision)
  }

  /** 新しい保存を止め、進行中のStore書き込みだけは完了させる。 */
  function dispose(): void {
    disposed = true
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = undefined
  }

  return {
    markChanged,
    requestFlush,
    flush,
    hasPending,
    dispose,
  }
}
