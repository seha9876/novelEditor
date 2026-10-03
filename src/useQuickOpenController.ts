import { computed, ref, watch, type Ref } from 'vue'
import { createProjectFileCandidates, searchProjectFiles } from './projectFileSearch'
import type { ProjectTreeSnapshot } from './projectTreeModel'
import type { ProjectTreeOpenRequest, ProjectTreeOpenResult } from './projectTreeWindow'

type QuickOpenOptions = {
  snapshot: Readonly<Ref<ProjectTreeSnapshot>>
  disabled: Readonly<Ref<boolean>>
  openFile: (request: ProjectTreeOpenRequest) => Promise<void>
}

/** ファイル検索の一時状態と文書を開く要求を管理する。本文と保存状態は既存セッションへ委ねる。 */
export function useQuickOpenController(options: QuickOpenOptions) {
  const isOpen = ref(false)
  const query = ref('')
  const allProjects = ref(false)
  const selectedNodeId = ref<number | null>(null)
  const error = ref('')
  const focusRevision = ref(0)
  const pendingRequestId = ref<string | null>(null)
  const pending = computed(() => pendingRequestId.value !== null)
  let disposed = false
  const candidates = computed(() => createProjectFileCandidates(options.snapshot.value))
  const results = computed(() => searchProjectFiles(candidates.value, query.value, options.snapshot.value.activeProjectId, allProjects.value))

  const stopResultsWatch = watch(results, (next) => {
    if (!next.candidates.some((candidate) => candidate.nodeId === selectedNodeId.value)) {
      selectedNodeId.value = next.candidates[0]?.nodeId ?? null
    }
  }, { flush: 'sync', immediate: true })
  const stopConditionsWatch = watch([query, allProjects], () => {
    selectedNodeId.value = results.value.candidates[0]?.nodeId ?? null
    error.value = ''
  }, { flush: 'sync' })

  /** 新しく開くときだけ検索条件を初期化し、再操作時は入力欄へフォーカスを戻す。 */
  function open(): void {
    if (disposed || options.disabled.value || pending.value) return
    if (!isOpen.value) {
      query.value = ''
      allProjects.value = false
      selectedNodeId.value = results.value.candidates[0]?.nodeId ?? null
      error.value = ''
      isOpen.value = true
    }
    focusRevision.value += 1
  }

  /** 読込中以外は取り消せる。処理中の終了要求は文書セッションの結果を待つ。 */
  function close(): void {
    if (pending.value) return
    isOpen.value = false
  }

  /** 表示中の候補だけを選択し、キーボードとクリックの選択を一致させる。 */
  function select(nodeId: number): void {
    if (disposed || pending.value || options.disabled.value) return
    if (results.value.candidates.some((candidate) => candidate.nodeId === nodeId)) selectedNodeId.value = nodeId
  }

  /** 上下キーでは表示候補の端で止まり、本文はまだ開かない。 */
  function moveSelection(direction: -1 | 1): void {
    const items = results.value.candidates
    if (!items.length) return
    const current = items.findIndex((candidate) => candidate.nodeId === selectedNodeId.value)
    const index = Math.min(items.length - 1, Math.max(0, current < 0 ? 0 : current + direction))
    select(items[index].nodeId)
  }

  /** 自分の要求に対応する結果だけを受け取り、別の窓や旧要求の通知で画面を閉じない。 */
  function receiveOpenResult(result: ProjectTreeOpenResult): boolean {
    if (disposed || !isOpen.value || result.requestId !== pendingRequestId.value) return false
    pendingRequestId.value = null
    if (result.error) error.value = result.error
    else isOpen.value = false
    return true
  }

  /** 選択時のパスを同封し、検索後に再指定された別原稿を誤って開かないようにする。 */
  async function openSelected(nodeId = selectedNodeId.value): Promise<void> {
    if (disposed || !isOpen.value || options.disabled.value || pending.value) return
    const candidate = results.value.candidates.find((item) => item.nodeId === nodeId)
    if (!candidate) return
    selectedNodeId.value = candidate.nodeId
    const requestId = crypto.randomUUID()
    pendingRequestId.value = requestId
    error.value = ''
    try {
      await options.openFile({ requestId, nodeId: candidate.nodeId, projectId: candidate.projectId, expectedPath: candidate.path })
      if (!disposed && pendingRequestId.value === requestId) {
        error.value = 'ファイルを開く結果を確認できませんでした。もう一度操作してください。'
      }
    } catch (failure) {
      if (!disposed && pendingRequestId.value === requestId) error.value = String(failure)
    } finally {
      if (pendingRequestId.value === requestId) pendingRequestId.value = null
    }
  }

  /** 画面の終了時に監視と保留要求を解除し、遅着した結果を無効化する。 */
  function dispose(): void {
    disposed = true
    stopResultsWatch()
    stopConditionsWatch()
    pendingRequestId.value = null
    isOpen.value = false
  }

  return { isOpen, query, allProjects, selectedNodeId, error, focusRevision, pending, results, open, close, select, moveSelection, openSelected, receiveOpenResult, dispose }
}
