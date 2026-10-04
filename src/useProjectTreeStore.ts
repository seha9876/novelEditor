/** プロジェクトツリーのDB読込、更新後再取得、進捗とエラー状態を管理する。 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ref, type Ref } from 'vue'
import type { ProjectTreeSnapshot } from './projectTreeModel'
import { notifyProjectTreeChanged } from './projectTreeClient'
import { PROJECT_TREE_CHANGED_EVENT, type ProjectTreeChangedEvent } from './projectTreeWindow'

type SnapshotLoader = () => Promise<ProjectTreeSnapshot>
type MutationAction = () => Promise<void>
type ErrorNotifier = (error: unknown) => Promise<void>
type MutationOptions = { setErrorOnFailure?: boolean }

export type ProjectTreeStoreOptions = {
  loadSnapshot: SnapshotLoader
  canMutate: () => boolean
  showError: ErrorNotifier
  onSnapshotRefreshed?: (snapshot: ProjectTreeSnapshot) => void
  onSyncError?: (error: unknown) => void
  sourceId?: string
}

/** ツリーの保存状態を画面から分離し、更新操作の後始末を一元管理する。 */
export function useProjectTreeStore(options: ProjectTreeStoreOptions) {
  const snapshot: Ref<ProjectTreeSnapshot> = ref({ projects: [], nodes: [], activeProjectId: null })
  const loading = ref(true)
  const mutationPending = ref(false)
  const delayedProgress = ref(false)
  const treeError = ref('')
  let delayedProgressTimer: ReturnType<typeof setTimeout> | undefined
  let lifecycleGeneration = 0
  let disposed = false
  const sourceId = options.sourceId ?? crypto.randomUUID()
  let changeRevision = 0
  let unlistenProjectTreeChanged: UnlistenFn | undefined
  let setupPromise: Promise<void> | null = null
  let refreshPromise: Promise<void> | null = null
  let refreshQueued = false
  let refreshSequence = 0

  /** 破棄後の非同期完了から、画面状態を更新してよいか確認する。 */
  function isActive(generation: number): boolean {
    return !disposed && generation === lifecycleGeneration
  }

  /** 遅延中表示のタイマーを解除し、同じタイマーを二重管理しない。 */
  function clearDelayedProgressTimer(): void {
    if (delayedProgressTimer !== undefined) clearTimeout(delayedProgressTimer)
    delayedProgressTimer = undefined
  }

  /** DBから最新のツリーを読み込み、古い結果で表示を巻き戻さない。 */
  async function refreshSnapshot(): Promise<void> {
    // 読込開始前ではなく要求受付時に世代を進め、進行中の古い結果を破棄する。
    refreshSequence += 1
    refreshQueued = true
    if (refreshPromise) return refreshPromise
    const refreshRun = (async () => {
      while (refreshQueued && !disposed) {
        refreshQueued = false
        const generation = lifecycleGeneration
        const sequence = refreshSequence
        let nextSnapshot: ProjectTreeSnapshot
        try {
          nextSnapshot = await options.loadSnapshot()
        } catch (error) {
          // 読込中に新しい要求が来ていれば、古い失敗を最新要求へ伝播させない。
          if (!isActive(generation) || sequence !== refreshSequence) continue
          throw error
        }
        if (!isActive(generation) || sequence !== refreshSequence) continue
        snapshot.value = nextSnapshot
        options.onSnapshotRefreshed?.(nextSnapshot)
        treeError.value = ''
      }
    })()
    refreshPromise = refreshRun
    try {
      await refreshRun
    } finally {
      if (refreshPromise === refreshRun) refreshPromise = null
    }
  }

  /** 他画面の変更通知を集約し、現在の読込完了後に最新状態を一度だけ取得する。 */
  function handleProjectTreeChanged(event: ProjectTreeChangedEvent): void {
    if (disposed || !event || event.sourceId === sourceId) return
    void refreshSnapshot().catch((error) => {
      if (!disposed) treeError.value = String(error)
    })
  }

  /** 変更イベントの購読を開始し、購読完了後に破棄された場合も解除する。 */
  async function setup(): Promise<void> {
    if (disposed) return
    if (setupPromise) return setupPromise
    const setupRun = (async () => {
      if (disposed || unlistenProjectTreeChanged) return
      const lateUnlisten = await listen<ProjectTreeChangedEvent>(PROJECT_TREE_CHANGED_EVENT, (event) => {
        handleProjectTreeChanged(event.payload)
      })
      if (disposed) {
        lateUnlisten()
        return
      }
      unlistenProjectTreeChanged = lateUnlisten
    })()
    setupPromise = setupRun
    try {
      await setupRun
    } catch (error) {
      if (!disposed) {
        options.onSyncError?.(error)
        if (!options.onSyncError) console.error('プロジェクトツリーの変更通知を購読できません。', error)
      }
    } finally {
      if (setupPromise === setupRun) setupPromise = null
    }
  }

  /** 初回表示時に保存済みプロジェクトとツリーを読み込む。 */
  async function initializeTree(): Promise<void> {
    if (disposed) return
    const generation = lifecycleGeneration
    loading.value = true
    treeError.value = ''
    try {
      await refreshSnapshot()
    } catch (error) {
      if (isActive(generation)) treeError.value = String(error)
    } finally {
      if (isActive(generation)) loading.value = false
    }
  }

  /** DB更新を一度に一つだけ実行し、成功後に保存済み状態を再取得する。 */
  async function runMutation(action: MutationAction, mutationOptions: MutationOptions = {}): Promise<boolean> {
    if (disposed || !options.canMutate() || loading.value || mutationPending.value || Boolean(treeError.value)) return false
    const generation = lifecycleGeneration
    mutationPending.value = true
    clearDelayedProgressTimer()
    const progressTimer = setTimeout(() => {
      if (isActive(generation)) delayedProgress.value = true
    }, 250)
    delayedProgressTimer = progressTimer
    let mutationSucceeded = false
    try {
      await action()
      mutationSucceeded = true
      // DB更新は画面の寿命や再読込の成否と独立して完了するため、他画面へ先に通知する。
      changeRevision += 1
      void notifyProjectTreeChanged(sourceId, changeRevision).catch((error) => {
        console.error('プロジェクトツリーの変更通知を送信できませんでした。', error)
      })
      if (!isActive(generation)) return false
      await refreshSnapshot()
      if (!isActive(generation)) return false
      return true
    } catch (error) {
      if (!isActive(generation)) return false
      if (mutationSucceeded || mutationOptions.setErrorOnFailure) treeError.value = String(error)
      await options.showError(error)
      return false
    } finally {
      clearTimeout(progressTimer)
      if (delayedProgressTimer === progressTimer) delayedProgressTimer = undefined
      if (isActive(generation)) {
        delayedProgress.value = false
        mutationPending.value = false
      }
    }
  }

  /** 画面破棄時に遅延表示を解除し、保留中DB操作のUI反映だけを無効にする。 */
  function dispose(): void {
    if (disposed) return
    disposed = true
    lifecycleGeneration += 1
    clearDelayedProgressTimer()
    unlistenProjectTreeChanged?.()
    unlistenProjectTreeChanged = undefined
    refreshQueued = false
    delayedProgress.value = false
    mutationPending.value = false
  }

  return {
    snapshot,
    loading,
    mutationPending,
    delayedProgress,
    treeError,
    initializeTree,
    runMutation,
    setup,
    dispose,
  }
}
