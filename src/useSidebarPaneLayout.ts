/** サイドバーのドック幅、開閉、画面幅制約と表示設定の保存を分離する。 */
import { computed, ref, watch, type Ref } from 'vue'
import { saveSidebarPreferences } from './appPreferences'
import type { SidebarPanelId } from './sidebarModel'
import type { ApplicationPreferencesV1 } from './appPreferenceSchema'

type SidebarPaneLayoutOptions = {
  initialPreferences: ApplicationPreferencesV1
  detached: Ref<boolean>
  showPersistenceNotice: (text: string) => void
}

/** ドック幅・開閉の表示と操作、および設定保存のライフサイクルを所有する。 */
export function useSidebarPaneLayout(options: SidebarPaneLayoutOptions) {
  const activePanel = ref<SidebarPanelId>(options.initialPreferences.ui.sidebar.activePanel)
  const sidebarWidth = ref(options.initialPreferences.ui.sidebar.width)
  const sidebarCollapsed = ref(options.initialPreferences.ui.sidebar.collapsed ?? false)
  const sidebarResizing = ref(false)
  const mainViewportWidth = ref(window.innerWidth)
  const sidebarMaximumWidth = ref(Math.max(220, Math.min(480, mainViewportWidth.value - 320)))
  const sidebarDisplayWidth = ref(Math.min(sidebarWidth.value, sidebarMaximumWidth.value))
  const resizePreview = ref<{ width: number; collapsed: boolean } | null>(null)
  const sidebarVisuallyCollapsed = computed(() => resizePreview.value?.collapsed ?? sidebarCollapsed.value)
  const sidebarDrawerWidth = computed(() => sidebarVisuallyCollapsed.value
    ? 36
    : Math.min(resizePreview.value?.width ?? sidebarDisplayWidth.value, sidebarMaximumWidth.value))

  let unlistenViewportResize: (() => void) | undefined
  let sidebarSaveTimer: ReturnType<typeof setTimeout> | undefined
  let sidebarSavePromise = Promise.resolve()
  let sidebarResizeStart: {
    pointerId: number
    startX: number
    startWidth: number
    target: HTMLElement
    hadPendingSave: boolean
  } | null = null
  let disposed = false
  const stopDetachedWatch = watch(options.detached, (detached) => {
    if (detached) cancelSidebarResize()
  }, { flush: 'sync' })

  /** 現在の画面幅に合わせて表示上限と実効幅を更新する。 */
  function updateSidebarDisplayMetrics(): void {
    mainViewportWidth.value = window.innerWidth
    sidebarMaximumWidth.value = Math.max(220, Math.min(480, mainViewportWidth.value - 320))
    sidebarDisplayWidth.value = Math.min(sidebarWidth.value, sidebarMaximumWidth.value)
  }

  /** メイン画面の実幅を取り直し、本文の最小幅を保つ表示上限を更新する。 */
  function updateMainViewportWidth(): void {
    if (disposed) return
    updateSidebarDisplayMetrics()
  }

  /** 最新のサイドバー幅・開閉・分離状態を設定Storeへ直列保存する。 */
  function persistSidebarPreferences(): Promise<void> {
    sidebarSavePromise = sidebarSavePromise.catch(() => undefined).then(async () => {
      try {
        await saveSidebarPreferences({
          width: sidebarWidth.value,
          activePanel: activePanel.value,
          collapsed: sidebarCollapsed.value,
        }, options.detached.value)
      } catch (error) {
        if (!disposed) options.showPersistenceNotice(`サイドバーの表示設定を保存できません。${String(error)}`)
      }
    })
    return sidebarSavePromise
  }

  /** 連続した表示設定の変更をまとめ、最後の状態だけを保存する。 */
  function scheduleSidebarPreferencesSave(): void {
    if (disposed) return
    if (sidebarSaveTimer) clearTimeout(sidebarSaveTimer)
    sidebarSaveTimer = setTimeout(() => {
      sidebarSaveTimer = undefined
      void persistSidebarPreferences()
    }, 250)
  }

  /** 展開時の幅を保ったまま開閉を切り替え、幅変更中の競合を防ぐ。 */
  function toggleSidebarCollapsed(): void {
    if (disposed || sidebarResizing.value) return
    sidebarCollapsed.value = !sidebarCollapsed.value
    scheduleSidebarPreferencesSave()
  }

  /** 未確定のドラッグを取り消し、終了前に遅延中の表示設定保存を完了させる。 */
  async function flush(): Promise<void> {
    cancelSidebarResize()
    if (sidebarSaveTimer) {
      clearTimeout(sidebarSaveTimer)
      sidebarSaveTimer = undefined
      await persistSidebarPreferences()
    } else {
      await sidebarSavePromise
    }
  }

  /** キーボードで指定された幅へ表示上限を適用し、設定保存を予約する。 */
  function setSidebarWidth(width: number): void {
    sidebarWidth.value = Math.max(220, Math.min(sidebarMaximumWidth.value, Math.round(width)))
    sidebarDisplayWidth.value = sidebarWidth.value
    scheduleSidebarPreferencesSave()
  }

  /** 確定済みの幅を変更せず、開始位置・保留保存とポインター捕捉を記録する。 */
  function startSidebarResize(event: PointerEvent): void {
    if (event.button !== 0 || disposed || sidebarResizeStart) return
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const hadPendingSave = sidebarSaveTimer !== undefined
    if (sidebarSaveTimer !== undefined) {
      clearTimeout(sidebarSaveTimer)
      sidebarSaveTimer = undefined
    }
    event.preventDefault()
    sidebarResizeStart = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarDrawerWidth.value,
      target,
      hadPendingSave,
    }
    resizePreview.value = { width: sidebarDisplayWidth.value, collapsed: sidebarCollapsed.value }
    sidebarResizing.value = true
  }

  /** 128pxを境に開閉をプレビューし、保存対象の幅と開閉状態は確定まで維持する。 */
  function moveSidebarResize(event: PointerEvent): void {
    if (sidebarResizeStart?.pointerId !== event.pointerId || disposed) return
    const width = sidebarResizeStart.startWidth + event.clientX - sidebarResizeStart.startX
    resizePreview.value = {
      width: Math.max(220, Math.min(sidebarMaximumWidth.value, Math.round(width))),
      collapsed: width < 128,
    }
  }

  /** 捕捉を解放する前に操作を終了扱いにし、遅着する捕捉喪失との二重処理を防ぐ。 */
  function clearSidebarResize(): void {
    const drag = sidebarResizeStart
    sidebarResizeStart = null
    resizePreview.value = null
    sidebarResizing.value = false
    if (drag?.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId)
  }

  /** 離した位置で確定し、閉じる場合は開始前の展開幅を残して一度だけ保存予約する。 */
  function endSidebarResize(event: PointerEvent): void {
    if (sidebarResizeStart?.pointerId !== event.pointerId || disposed) return
    const drag = sidebarResizeStart
    moveSidebarResize(event)
    const preview = resizePreview.value!
    const nextWidth = preview.collapsed || event.clientX === drag.startX ? sidebarWidth.value : preview.width
    const changed = sidebarCollapsed.value !== preview.collapsed || sidebarWidth.value !== nextWidth
    sidebarCollapsed.value = preview.collapsed
    sidebarWidth.value = nextWidth
    updateSidebarDisplayMetrics()
    clearSidebarResize()
    if (changed || drag.hadPendingSave) scheduleSidebarPreferencesSave()
  }

  /** キャンセル・予期しない捕捉喪失ではプレビューを捨て、開始前の保留保存だけ再開する。 */
  function cancelSidebarResize(event?: PointerEvent): void {
    if (!sidebarResizeStart || (event && sidebarResizeStart.pointerId !== event.pointerId)) return
    const hadPendingSave = sidebarResizeStart.hadPendingSave
    clearSidebarResize()
    if (hadPendingSave) scheduleSidebarPreferencesSave()
  }

  /** 左右キーと Home/End でサイドバー幅を調整する。 */
  function onSidebarResizeKeydown(event: KeyboardEvent): void {
    if (disposed || sidebarResizing.value || sidebarCollapsed.value) return
    if (event.key === 'ArrowLeft') setSidebarWidth(sidebarDisplayWidth.value - 16)
    else if (event.key === 'ArrowRight') setSidebarWidth(sidebarDisplayWidth.value + 16)
    else if (event.key === 'Home') setSidebarWidth(220)
    else if (event.key === 'End') setSidebarWidth(sidebarMaximumWidth.value)
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
    cancelSidebarResize()
    disposed = true
    stopDetachedWatch()
    unlistenViewportResize?.()
    unlistenViewportResize = undefined
    const hadScheduledSave = sidebarSaveTimer !== undefined
    if (sidebarSaveTimer) clearTimeout(sidebarSaveTimer)
    sidebarSaveTimer = undefined
    if (hadScheduledSave) await persistSidebarPreferences()
    else await sidebarSavePromise
  }

  /** 別パネルを選ぶと開き、同じボタンを押すと開閉する。幅や本文は変更しない。 */
  function selectPanel(panel: SidebarPanelId, toggle = true): void {
    if (disposed || sidebarResizing.value) return
    sidebarCollapsed.value = toggle && activePanel.value === panel ? !sidebarCollapsed.value : false
    activePanel.value = panel
    scheduleSidebarPreferencesSave()
  }

  return {
    activePanel,
    selectPanel,
    sidebarCollapsed,
    sidebarVisuallyCollapsed,
    sidebarDrawerWidth,
    toggleSidebarCollapsed,
    sidebarResizing,
    sidebarMaximumWidth,
    sidebarDisplayWidth,
    scheduleSidebarPreferencesSave,
    startSidebarResize,
    moveSidebarResize,
    endSidebarResize,
    cancelSidebarResize,
    onSidebarResizeKeydown,
    setup,
    flush,
    dispose,
  }
}
