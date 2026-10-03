/** プロジェクトツリーのドック幅、開閉、画面幅制約と表示設定の保存を分離する。 */
import { computed, ref, watch, type Ref } from 'vue'
import { saveProjectTreePreferences } from './appPreferences'
import type { ApplicationPreferencesV1 } from './appPreferenceSchema'

type ProjectTreePaneLayoutOptions = {
  initialPreferences: ApplicationPreferencesV1
  detached: Ref<boolean>
  showPersistenceNotice: (text: string) => void
}

/** ドック幅・開閉の表示と操作、および設定保存のライフサイクルを所有する。 */
export function useProjectTreePaneLayout(options: ProjectTreePaneLayoutOptions) {
  const projectTreeWidth = ref(options.initialPreferences.ui.projectTree.width)
  const projectTreeCollapsed = ref(options.initialPreferences.ui.projectTree.collapsed ?? false)
  const projectTreeResizing = ref(false)
  const mainViewportWidth = ref(window.innerWidth)
  const projectTreeMaximumWidth = ref(Math.max(220, Math.min(480, mainViewportWidth.value - 320)))
  const projectTreeDisplayWidth = ref(Math.min(projectTreeWidth.value, projectTreeMaximumWidth.value))
  const resizePreview = ref<{ width: number; collapsed: boolean } | null>(null)
  const projectTreeVisuallyCollapsed = computed(() => resizePreview.value?.collapsed ?? projectTreeCollapsed.value)
  const projectTreeDrawerWidth = computed(() => projectTreeVisuallyCollapsed.value
    ? 36
    : Math.min(resizePreview.value?.width ?? projectTreeDisplayWidth.value, projectTreeMaximumWidth.value))

  let unlistenViewportResize: (() => void) | undefined
  let projectTreeSaveTimer: ReturnType<typeof setTimeout> | undefined
  let projectTreeSavePromise = Promise.resolve()
  let projectTreeResizeStart: {
    pointerId: number
    startX: number
    startWidth: number
    target: HTMLElement
    hadPendingSave: boolean
  } | null = null
  let disposed = false
  const stopDetachedWatch = watch(options.detached, (detached) => {
    if (detached) cancelProjectTreeResize()
  }, { flush: 'sync' })

  /** 現在の画面幅に合わせて表示上限と実効幅を更新する。 */
  function updateProjectTreeDisplayMetrics(): void {
    mainViewportWidth.value = window.innerWidth
    projectTreeMaximumWidth.value = Math.max(220, Math.min(480, mainViewportWidth.value - 320))
    projectTreeDisplayWidth.value = Math.min(projectTreeWidth.value, projectTreeMaximumWidth.value)
  }

  /** メイン画面の実幅を取り直し、本文の最小幅を保つ表示上限を更新する。 */
  function updateMainViewportWidth(): void {
    if (disposed) return
    updateProjectTreeDisplayMetrics()
  }

  /** 最新のツリー幅・開閉・分離状態を設定Storeへ直列保存する。 */
  function persistProjectTreePreferences(): Promise<void> {
    projectTreeSavePromise = projectTreeSavePromise.catch(() => undefined).then(async () => {
      try {
        await saveProjectTreePreferences({
          width: projectTreeWidth.value,
          detached: options.detached.value,
          collapsed: projectTreeCollapsed.value,
        })
      } catch (error) {
        if (!disposed) options.showPersistenceNotice(`プロジェクトツリーの表示設定を保存できません。${String(error)}`)
      }
    })
    return projectTreeSavePromise
  }

  /** 連続した表示設定の変更をまとめ、最後の状態だけを保存する。 */
  function scheduleProjectTreePreferencesSave(): void {
    if (disposed) return
    if (projectTreeSaveTimer) clearTimeout(projectTreeSaveTimer)
    projectTreeSaveTimer = setTimeout(() => {
      projectTreeSaveTimer = undefined
      void persistProjectTreePreferences()
    }, 250)
  }

  /** 展開時の幅を保ったまま開閉を切り替え、分離中や幅変更中の競合を防ぐ。 */
  function toggleProjectTreeCollapsed(): void {
    if (disposed || options.detached.value || projectTreeResizing.value) return
    projectTreeCollapsed.value = !projectTreeCollapsed.value
    scheduleProjectTreePreferencesSave()
  }

  /** 未確定のドラッグを取り消し、終了前に遅延中の表示設定保存を完了させる。 */
  async function flush(): Promise<void> {
    cancelProjectTreeResize()
    if (projectTreeSaveTimer) {
      clearTimeout(projectTreeSaveTimer)
      projectTreeSaveTimer = undefined
      await persistProjectTreePreferences()
    } else {
      await projectTreeSavePromise
    }
  }

  /** キーボードで指定された幅へ表示上限を適用し、設定保存を予約する。 */
  function setProjectTreeWidth(width: number): void {
    projectTreeWidth.value = Math.max(220, Math.min(projectTreeMaximumWidth.value, Math.round(width)))
    projectTreeDisplayWidth.value = projectTreeWidth.value
    scheduleProjectTreePreferencesSave()
  }

  /** 確定済みの幅を変更せず、開始位置・保留保存とポインター捕捉を記録する。 */
  function startProjectTreeResize(event: PointerEvent): void {
    if (event.button !== 0 || disposed || projectTreeResizeStart || options.detached.value) return
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const hadPendingSave = projectTreeSaveTimer !== undefined
    if (projectTreeSaveTimer !== undefined) {
      clearTimeout(projectTreeSaveTimer)
      projectTreeSaveTimer = undefined
    }
    event.preventDefault()
    projectTreeResizeStart = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: projectTreeDrawerWidth.value,
      target,
      hadPendingSave,
    }
    resizePreview.value = { width: projectTreeDisplayWidth.value, collapsed: projectTreeCollapsed.value }
    projectTreeResizing.value = true
  }

  /** 128pxを境に開閉をプレビューし、保存対象の幅と開閉状態は確定まで維持する。 */
  function moveProjectTreeResize(event: PointerEvent): void {
    if (projectTreeResizeStart?.pointerId !== event.pointerId || disposed) return
    const width = projectTreeResizeStart.startWidth + event.clientX - projectTreeResizeStart.startX
    resizePreview.value = {
      width: Math.max(220, Math.min(projectTreeMaximumWidth.value, Math.round(width))),
      collapsed: width < 128,
    }
  }

  /** 捕捉を解放する前に操作を終了扱いにし、遅着する捕捉喪失との二重処理を防ぐ。 */
  function clearProjectTreeResize(): void {
    const drag = projectTreeResizeStart
    projectTreeResizeStart = null
    resizePreview.value = null
    projectTreeResizing.value = false
    if (drag?.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId)
  }

  /** 離した位置で確定し、閉じる場合は開始前の展開幅を残して一度だけ保存予約する。 */
  function endProjectTreeResize(event: PointerEvent): void {
    if (projectTreeResizeStart?.pointerId !== event.pointerId || disposed) return
    const drag = projectTreeResizeStart
    moveProjectTreeResize(event)
    const preview = resizePreview.value!
    const nextWidth = preview.collapsed || event.clientX === drag.startX ? projectTreeWidth.value : preview.width
    const changed = projectTreeCollapsed.value !== preview.collapsed || projectTreeWidth.value !== nextWidth
    projectTreeCollapsed.value = preview.collapsed
    projectTreeWidth.value = nextWidth
    updateProjectTreeDisplayMetrics()
    clearProjectTreeResize()
    if (changed || drag.hadPendingSave) scheduleProjectTreePreferencesSave()
  }

  /** キャンセル・予期しない捕捉喪失ではプレビューを捨て、開始前の保留保存だけ再開する。 */
  function cancelProjectTreeResize(event?: PointerEvent): void {
    if (!projectTreeResizeStart || (event && projectTreeResizeStart.pointerId !== event.pointerId)) return
    const hadPendingSave = projectTreeResizeStart.hadPendingSave
    clearProjectTreeResize()
    if (hadPendingSave) scheduleProjectTreePreferencesSave()
  }

  /** 左右キーと Home/End でツリー幅を調整する。 */
  function onProjectTreeResizeKeydown(event: KeyboardEvent): void {
    if (disposed || projectTreeResizing.value || projectTreeCollapsed.value || options.detached.value) return
    if (event.key === 'ArrowLeft') setProjectTreeWidth(projectTreeDisplayWidth.value - 16)
    else if (event.key === 'ArrowRight') setProjectTreeWidth(projectTreeDisplayWidth.value + 16)
    else if (event.key === 'Home') setProjectTreeWidth(220)
    else if (event.key === 'End') setProjectTreeWidth(projectTreeMaximumWidth.value)
    else return
    event.preventDefault()
  }

  /** 画面の幅購読を開始し、多重登録を防ぐ。 */
  function setup(): void {
    if (disposed || unlistenViewportResize) return
    window.addEventListener('resize', updateMainViewportWidth)
    unlistenViewportResize = () => window.removeEventListener('resize', updateMainViewportWidth)
  }

  /** ドラッグを取り消して購読を解除し、確定済みの表示設定の保留保存を完了させる。 */
  async function dispose(): Promise<void> {
    if (disposed) return
    cancelProjectTreeResize()
    disposed = true
    stopDetachedWatch()
    unlistenViewportResize?.()
    unlistenViewportResize = undefined
    const hadScheduledSave = projectTreeSaveTimer !== undefined
    if (projectTreeSaveTimer) clearTimeout(projectTreeSaveTimer)
    projectTreeSaveTimer = undefined
    if (hadScheduledSave) await persistProjectTreePreferences()
    else await projectTreeSavePromise
  }

  return {
    projectTreeCollapsed,
    projectTreeVisuallyCollapsed,
    projectTreeDrawerWidth,
    toggleProjectTreeCollapsed,
    projectTreeResizing,
    projectTreeMaximumWidth,
    projectTreeDisplayWidth,
    scheduleProjectTreePreferencesSave,
    startProjectTreeResize,
    moveProjectTreeResize,
    endProjectTreeResize,
    cancelProjectTreeResize,
    onProjectTreeResizeKeydown,
    setup,
    flush,
    dispose,
  }
}
