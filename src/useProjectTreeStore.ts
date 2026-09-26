/** プロジェクトツリーのDB読込、更新後再取得、進捗とエラー状態を管理する。 */
import { ref, type Ref } from 'vue'
import type { ProjectTreeSnapshot } from './projectTreeModel'

type SnapshotLoader = () => Promise<ProjectTreeSnapshot>
type MutationAction = () => Promise<void>
type ErrorNotifier = (error: unknown) => Promise<void>
type MutationOptions = { setErrorOnFailure?: boolean }

export type ProjectTreeStoreOptions = {
  loadSnapshot: SnapshotLoader
  canMutate: () => boolean
  showError: ErrorNotifier
  onSnapshotRefreshed?: (snapshot: ProjectTreeSnapshot) => void
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

  /** 破棄後の非同期完了から、画面状態を更新してよいか確認する。 */
  function isActive(generation: number): boolean {
    return !disposed && generation === lifecycleGeneration
  }

  /** 遅延中表示のタイマーを解除し、同じタイマーを二重管理しない。 */
  function clearDelayedProgressTimer(): void {
    if (delayedProgressTimer !== undefined) clearTimeout(delayedProgressTimer)
    delayedProgressTimer = undefined
  }

  /** DBから最新のツリーを読み込み、表示側へ同期完了を通知する。 */
  async function refreshSnapshot(): Promise<void> {
    const generation = lifecycleGeneration
    const nextSnapshot = await options.loadSnapshot()
    if (!isActive(generation)) return
    snapshot.value = nextSnapshot
    options.onSnapshotRefreshed?.(nextSnapshot)
    treeError.value = ''
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
    dispose,
  }
}
