/** プロジェクトツリーのドック幅、画面幅制約、幅設定の保存を分離する。 */
import { ref, type Ref } from 'vue'
import { saveProjectTreePreferences } from './appPreferences'
import type { ApplicationPreferencesV1 } from './appPreferenceSchema'

type ProjectTreePaneLayoutOptions = {
  initialPreferences: ApplicationPreferencesV1
  detached: Ref<boolean>
  showPersistenceNotice: (text: string) => void
}

/** ドック幅の表示・操作と設定保存のライフサイクルを所有する。 */
export function useProjectTreePaneLayout(options: ProjectTreePaneLayoutOptions) {
  const projectTreeWidth = ref(options.initialPreferences.ui.projectTree.width)
  const projectTreeResizing = ref(false)
  const mainViewportWidth = ref(window.innerWidth)
  const projectTreeMaximumWidth = ref(Math.max(220, Math.min(480, mainViewportWidth.value - 320)))
  const projectTreeDisplayWidth = ref(Math.min(projectTreeWidth.value, projectTreeMaximumWidth.value))

  let unlistenViewportResize: (() => void) | undefined
  let projectTreeSaveTimer: ReturnType<typeof setTimeout> | undefined
  let projectTreeSavePromise = Promise.resolve()
  let projectTreeResizeStart: { pointerId: number; startX: number; startWidth: number } | null = null
  let disposed = false

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

  /** 最新のツリー幅と分離状態を設定Storeへ直列保存する。 */
  function persistProjectTreePreferences(): Promise<void> {
    projectTreeSavePromise = projectTreeSavePromise.catch(() => undefined).then(async () => {
      try {
        await saveProjectTreePreferences({ width: projectTreeWidth.value, detached: options.detached.value })
      } catch (error) {
        if (!disposed) options.showPersistenceNotice(`プロジェクトツリーの表示設定を保存できません。${String(error)}`)
      }
    })
    return projectTreeSavePromise
  }

  /** 連続した幅変更をまとめ、最後の位置だけを保存する。 */
  function scheduleProjectTreePreferencesSave(): void {
    if (disposed) return
    if (projectTreeSaveTimer) clearTimeout(projectTreeSaveTimer)
    projectTreeSaveTimer = setTimeout(() => {
      projectTreeSaveTimer = undefined
      void persistProjectTreePreferences()
    }, 250)
  }

  /** 終了前に遅延中の表示設定保存を完了させる。 */
  async function flush(): Promise<void> {
    if (projectTreeSaveTimer) {
      clearTimeout(projectTreeSaveTimer)
      projectTreeSaveTimer = undefined
      await persistProjectTreePreferences()
    } else {
      await projectTreeSavePromise
    }
  }

  /** 表示上限を適用してツリー幅を更新し、必要な操作のときだけ設定保存を予約する。 */
  function setProjectTreeWidth(width: number, persist = true): void {
    projectTreeWidth.value = Math.max(220, Math.min(projectTreeMaximumWidth.value, Math.round(width)))
    projectTreeDisplayWidth.value = projectTreeWidth.value
    if (persist) scheduleProjectTreePreferencesSave()
  }

  /** 保留中の幅保存をドラッグ終了時へ集約し、開始幅とポインター捕捉を設定する。 */
  function startProjectTreeResize(event: PointerEvent): void {
    if (event.button !== 0 || disposed) return
    if (projectTreeSaveTimer !== undefined) {
      clearTimeout(projectTreeSaveTimer)
      projectTreeSaveTimer = undefined
    }
    event.preventDefault()
    projectTreeResizeStart = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: projectTreeDisplayWidth.value,
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    projectTreeResizing.value = true
  }

  /** ポインター移動量をドック幅へ反映する。 */
  function moveProjectTreeResize(event: PointerEvent): void {
    if (projectTreeResizeStart?.pointerId !== event.pointerId || disposed) return
    setProjectTreeWidth(projectTreeResizeStart.startWidth + event.clientX - projectTreeResizeStart.startX, false)
  }

  /** ドラッグ終了・キャンセル・キャプチャ喪失を確定し、幅を一度だけ保存予約する。 */
  function endProjectTreeResize(event: PointerEvent): void {
    if (projectTreeResizeStart?.pointerId !== event.pointerId) return
    projectTreeResizeStart = null
    projectTreeResizing.value = false
    scheduleProjectTreePreferencesSave()
  }

  /** 左右キーと Home/End でツリー幅を調整する。 */
  function onProjectTreeResizeKeydown(event: KeyboardEvent): void {
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

  /** 幅購読を解除し、保留中の表示設定保存を完了させる。 */
  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    unlistenViewportResize?.()
    unlistenViewportResize = undefined
    const hadScheduledSave = projectTreeSaveTimer !== undefined
    if (projectTreeSaveTimer) clearTimeout(projectTreeSaveTimer)
    projectTreeSaveTimer = undefined
    if (hadScheduledSave) await persistProjectTreePreferences()
    else await projectTreeSavePromise
  }

  return {
    projectTreeResizing,
    projectTreeMaximumWidth,
    projectTreeDisplayWidth,
    scheduleProjectTreePreferencesSave,
    startProjectTreeResize,
    moveProjectTreeResize,
    endProjectTreeResize,
    onProjectTreeResizeKeydown,
    setup,
    flush,
    dispose,
  }
}
