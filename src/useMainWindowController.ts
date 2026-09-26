/** メインウィンドウの表示状態と低レベル操作を画面本体から分離する。 */
import { currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window'
import { ref, type Ref } from 'vue'

type CloseRequestedEvent = { preventDefault: () => void }
type MainWindowHost = ReturnType<typeof getCurrentWindow>

export type MainWindowControllerOptions = {
  /** 実窓を差し替えると、ライフサイクルと終了順序をUI外で検証できる。 */
  appWindow?: MainWindowHost
  mainCloseInProgress: Ref<boolean>
  showError: (action: string, error: unknown) => Promise<void>
  onCloseRequested: () => Promise<void>
}

/** 最大化・最前面・終了イベントをTauriのメインウィンドウへ接続する。 */
export function useMainWindowController(options: MainWindowControllerOptions) {
  const appWindow = options.appWindow ?? getCurrentWindow()
  const maximized = ref(false)
  const alwaysOnTop = ref(false)
  let unlistenClose: (() => void) | undefined
  let unlistenResize: (() => void) | undefined
  let setupPromise: Promise<void> | null = null
  let disposed = false

  /** ウィンドウの最大化状態を取得し、タイトルバーのボタン表示を更新する。 */
  async function updateMaximized(): Promise<void> {
    const nextMaximized = await appWindow.isMaximized()
    if (!disposed) maximized.value = nextMaximized
  }

  /** ウィンドウを最小化する。 */
  async function minimizeWindow(): Promise<void> {
    try {
      await appWindow.minimize()
    } catch (error) {
      await options.showError('ウィンドウの最小化', error)
    }
  }

  /** 最大化と元のサイズを切り替え、ボタン表示を現在の状態に合わせる。 */
  async function toggleMaximizeWindow(): Promise<void> {
    try {
      await appWindow.toggleMaximize()
      await updateMaximized()
    } catch (error) {
      await options.showError('ウィンドウのサイズ変更', error)
    }
  }

  /** メニューから通常の最大化を行う。既に最大化されている場合はそのままにする。 */
  async function maximizeWindow(): Promise<void> {
    try {
      await appWindow.maximize()
      await updateMaximized()
    } catch (error) {
      await options.showError('ウィンドウの最大化', error)
    }
  }

  /** 現在のモニターの作業領域に合わせ、指定方向だけ窓を広げる。 */
  async function maximizeWindowAxis(axis: 'vertical' | 'horizontal'): Promise<void> {
    try {
      if (await appWindow.isMaximized()) await appWindow.unmaximize()
      const monitor = await currentMonitor()
      if (!monitor) throw new Error('現在のモニターを取得できませんでした。')

      const [position, outerSize, innerSize] = await Promise.all([
        appWindow.outerPosition(),
        appWindow.outerSize(),
        appWindow.innerSize(),
      ])
      const workArea = monitor.workArea
      // setSize は内側の寸法を指定するため、外側との差を差し引いて作業領域へ合わせる。
      const targetPosition = new PhysicalPosition(
        axis === 'horizontal' ? workArea.position.x : position.x,
        axis === 'vertical' ? workArea.position.y : position.y,
      )
      const targetSize = new PhysicalSize(
        axis === 'horizontal' ? workArea.size.width - (outerSize.width - innerSize.width) : innerSize.width,
        axis === 'vertical' ? workArea.size.height - (outerSize.height - innerSize.height) : innerSize.height,
      )
      await appWindow.setPosition(targetPosition)
      await appWindow.setSize(targetSize)
      await updateMaximized()
    } catch (error) {
      await options.showError('ウィンドウのサイズ変更', error)
    }
  }

  /** 現在のウィンドウの最前面表示を切り替え、成功後にチェック表示を更新する。 */
  async function toggleAlwaysOnTop(): Promise<void> {
    try {
      await appWindow.setAlwaysOnTop(!alwaysOnTop.value)
      alwaysOnTop.value = await appWindow.isAlwaysOnTop()
    } catch (error) {
      await options.showError('常に手前に表示', error)
    }
  }

  /** 通常の終了要求をOSへ送り、実際の確認と終了順序は呼び出し元へ委譲する。 */
  async function closeWindow(): Promise<void> {
    try {
      await appWindow.close()
    } catch (error) {
      await options.showError('ウィンドウを閉じる操作', error)
    }
  }

  /** Tauriの終了要求を横断調停へ渡し、重複要求だけを低レベルで抑止する。 */
  async function handleCloseRequest(event: CloseRequestedEvent): Promise<void> {
    event.preventDefault()
    if (disposed || options.mainCloseInProgress.value) return
    await options.onCloseRequested()
  }

  /** ウィンドウイベントを購読し、起動時の表示状態を反映する。 */
  async function setup(): Promise<void> {
    if (disposed) return
    if (setupPromise) return setupPromise
    if (unlistenClose && unlistenResize) return
    const setupRun = (async () => {
      if (!unlistenClose) {
        const lateUnlistenClose = await appWindow.onCloseRequested(handleCloseRequest)
        if (disposed) {
          lateUnlistenClose()
          return
        }
        unlistenClose = lateUnlistenClose
      }
      if (disposed) return
      if (!unlistenResize) {
        const lateUnlistenResize = await appWindow.onResized(() => {
          if (!disposed) void updateMaximized()
        })
        if (disposed) {
          lateUnlistenResize()
          return
        }
        unlistenResize = lateUnlistenResize
      }
      if (disposed) return
      await updateMaximized()
      if (disposed) return
      const nextAlwaysOnTop = await appWindow.isAlwaysOnTop()
      if (!disposed) alwaysOnTop.value = nextAlwaysOnTop
    })()
    setupPromise = setupRun
    try {
      await setupRun
    } finally {
      if (setupPromise === setupRun) setupPromise = null
    }
  }

  /** ウィンドウイベント購読を解除する。子窓や文書の終了順序は呼び出し元が調停する。 */
  function dispose(): void {
    disposed = true
    unlistenClose?.()
    unlistenClose = undefined
    unlistenResize?.()
    unlistenResize = undefined
  }

  return {
    appWindow,
    maximized,
    alwaysOnTop,
    minimizeWindow,
    toggleMaximizeWindow,
    maximizeWindow,
    maximizeWindowAxis,
    toggleAlwaysOnTop,
    closeWindow,
    setup,
    dispose,
  }
}
