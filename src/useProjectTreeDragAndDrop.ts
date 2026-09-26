/** プロジェクトツリーのポインター操作、ネイティブドロップ、購読解除を管理する。 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { DragDropEvent } from '@tauri-apps/api/webview'
import {
  hasProjectTreePointerDragStarted,
  projectTreeAutoScrollStep,
  projectTreeExternalDropDestination,
  projectTreePhysicalToViewport,
  projectTreeRowPlacement,
  shouldSuppressProjectTreeClick,
  type ProjectTreeNode,
  type ProjectTreePlacement,
  type ProjectTreeSnapshot,
} from './projectTreeModel'

export type PointerTreeDrag = {
  nodeId: number
  pointerId: number
  startX: number
  startY: number
  started: boolean
}

export type TreeDropTarget = {
  nodeId: number | null
  placement: ProjectTreePlacement
  parentId: number | null
}

type RunMutation = (action: () => Promise<void>) => Promise<boolean>

export type ProjectTreeDragAndDropOptions = {
  snapshot: Ref<ProjectTreeSnapshot>
  isBusy: () => boolean
  setNodeSelection: (nodeIds: number[], anchorNodeId?: number | null) => void
  runMutation: RunMutation
  moveProjectNode: (nodeId: number, targetId: number | null, placement: ProjectTreePlacement) => Promise<void>
  registerDroppedFiles: (paths: string[], parentId: number | null) => Promise<void>
}

/** ツリーのドラッグ状態をDOMイベントやTauri購読から分離する。 */
export function useProjectTreeDragAndDrop(options: ProjectTreeDragAndDropOptions) {
  const treeScrollElement = ref<HTMLElement | null>(null)
  const dragNodeId = ref<number | null>(null)
  const dropIndicator = ref<{ nodeId: number | null; placement: ProjectTreePlacement } | null>(null)
  const pointerTreeDrag = ref<PointerTreeDrag | null>(null)
  const externalDropActive = ref(false)
  let unlistenNativeDrop: (() => void) | null = null
  let nativeDropSetupCancelled = false
  let autoScrollFrame: number | null = null
  let latestPointerPosition = { x: 0, y: 0 }
  const suppressPointerGeneratedClick = ref(false)

  /** ツリー表示領域上の位置から、内部移動または外部登録の追加先を決める。 */
  function treeDropTargetAt(clientX: number, clientY: number, external: boolean): TreeDropTarget | null {
    const scroll = treeScrollElement.value
    const scrollBounds = scroll?.getBoundingClientRect()
    if (!scroll || !scrollBounds) return null
    const isWithinTree = clientX >= scrollBounds.left && clientX <= scrollBounds.right
      && clientY >= scrollBounds.top && clientY <= scrollBounds.bottom
    const row = isWithinTree
      ? document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('.project-tree-row')
      : null
    const nodeId = row && scroll.contains(row) ? Number(row.dataset.nodeId) : null
    const node = nodeId === null ? null : options.snapshot.value.nodes.find((item) => item.id === nodeId) ?? null

    if (external) {
      const destination = projectTreeExternalDropDestination(isWithinTree, node)
      if (!destination.accepted) return null
      if (destination.parentId !== null && node) {
        return { nodeId: node.id, placement: 'inside', parentId: destination.parentId }
      }
      return { nodeId: null, placement: 'root_end', parentId: null }
    }

    if (!isWithinTree) return null
    if (node && node.id !== dragNodeId.value) {
      const rowBounds = row!.getBoundingClientRect()
      const placement = projectTreeRowPlacement(node.kind, clientY, rowBounds.top, rowBounds.height)
      return { nodeId: node.id, placement, parentId: node.parentId }
    }
    if (node) return null
    return { nodeId: null, placement: 'root_end', parentId: null }
  }

  /** ドラッグ中のポインター位置に応じて自動スクロールを続ける。 */
  function continueTreeAutoScroll(): void {
    if (autoScrollFrame !== null) return
    const scrollFrame = (): void => {
      autoScrollFrame = null
      if (!pointerTreeDrag.value?.started) return
      const scroll = treeScrollElement.value
      if (!scroll) return
      const bounds = scroll.getBoundingClientRect()
      const scrollStep = projectTreeAutoScrollStep(latestPointerPosition, bounds)
      if (scrollStep === 0) return
      const previousTop = scroll.scrollTop
      scroll.scrollTop += scrollStep
      if (scroll.scrollTop === previousTop) return
      updateInternalDropTarget(latestPointerPosition.x, latestPointerPosition.y)
      autoScrollFrame = window.requestAnimationFrame(scrollFrame)
    }
    autoScrollFrame = window.requestAnimationFrame(scrollFrame)
  }

  /** 内部移動の開始後にマウス・ペン・タッチの移動を追跡する。 */
  function startPointerTreeDrag(event: PointerEvent, node: ProjectTreeNode): void {
    suppressPointerGeneratedClick.value = false
    if (event.button !== 0 || options.isBusy()) return
    pointerTreeDrag.value = {
      nodeId: node.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    }
    try {
      ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    } catch {
      // 要素が先に破棄された場合も、ウィンドウのポインターイベントで追跡する。
    }
  }

  /** ドラッグ中に表示する移動先を更新する。 */
  function updateInternalDropTarget(clientX: number, clientY: number): void {
    const target = treeDropTargetAt(clientX, clientY, false)
    dropIndicator.value = target ? { nodeId: target.nodeId, placement: target.placement } : null
  }

  /** 内部移動を開始してから、行の位置表示と端の自動スクロールを更新する。 */
  function trackPointerTreeDrag(event: PointerEvent): void {
    const gesture = pointerTreeDrag.value
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (!gesture.started && !hasProjectTreePointerDragStarted(
      { x: gesture.startX, y: gesture.startY }, { x: event.clientX, y: event.clientY },
    )) return
    if (options.isBusy()) {
      clearDragState()
      return
    }
    gesture.started = true
    options.setNodeSelection([gesture.nodeId], gesture.nodeId)
    dragNodeId.value = gesture.nodeId
    event.preventDefault()
    latestPointerPosition = { x: event.clientX, y: event.clientY }
    externalDropActive.value = false
    updateInternalDropTarget(event.clientX, event.clientY)
    continueTreeAutoScroll()
  }

  /** ポインターを放した場所へノードを移動し、通常の行クリックと区別する。 */
  function finishPointerTreeDrag(event: PointerEvent): void {
    const gesture = pointerTreeDrag.value
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (!gesture.started) {
      pointerTreeDrag.value = null
      return
    }
    latestPointerPosition = { x: event.clientX, y: event.clientY }
    const target = treeDropTargetAt(event.clientX, event.clientY, false)
    const sourceId = gesture.nodeId
    const canMove = Boolean(target) && (target?.nodeId === null || target?.nodeId !== sourceId) && !options.isBusy()
    suppressPointerGeneratedClick.value = true
    clearDragState()
    if (canMove && target) {
      void options.runMutation(() => options.moveProjectNode(sourceId, target.nodeId, target.placement))
    }
  }

  /** ポインター取消時に、移動予約を行わず表示だけを初期化する。 */
  function cancelPointerTreeDrag(event: PointerEvent): void {
    if (pointerTreeDrag.value?.pointerId !== event.pointerId) return
    clearDragState()
  }

  /** ドラッグ直後の合成クリックだけを抑止する。 */
  function shouldSuppressGeneratedClick(clickDetail: number): boolean {
    if (!shouldSuppressProjectTreeClick(suppressPointerGeneratedClick.value, clickDetail)) return false
    suppressPointerGeneratedClick.value = false
    return true
  }

  /** 物理座標で届くTauriのドロップ位置を、CSSピクセルのツリー要素へ変換する。 */
  function viewportPosition(position: { x: number; y: number }): { x: number; y: number } {
    return projectTreePhysicalToViewport(position, window.devicePixelRatio || 1)
  }

  /** 外部ファイルのネイティブドロップ位置を表示し、TXT登録先を明示する。 */
  function updateExternalDropTarget(position: { x: number; y: number }): void {
    if (options.isBusy()) {
      externalDropActive.value = false
      dropIndicator.value = null
      return
    }
    const point = viewportPosition(position)
    const target = treeDropTargetAt(point.x, point.y, true)
    externalDropActive.value = target !== null
    dropIndicator.value = target ? { nodeId: target.nodeId, placement: target.placement } : null
  }

  /** Tauriネイティブのファイルドロップをツリー領域だけで受け付ける。 */
  function handleNativeDropEvent(payload: DragDropEvent): void {
    if (payload.type === 'leave') {
      externalDropActive.value = false
      if (!pointerTreeDrag.value?.started) dropIndicator.value = null
      return
    }
    const point = viewportPosition(payload.position)
    const target = treeDropTargetAt(point.x, point.y, true)
    if (payload.type === 'drop') {
      externalDropActive.value = false
      dropIndicator.value = null
      if (target) void options.registerDroppedFiles(payload.paths, target.parentId)
      return
    }
    updateExternalDropTarget(payload.position)
  }

  /** ドラッグ終了時にポインター追跡・自動スクロール・移動表示を片付ける。 */
  function clearDragState(): void {
    pointerTreeDrag.value = null
    dragNodeId.value = null
    dropIndicator.value = null
    if (autoScrollFrame !== null) window.cancelAnimationFrame(autoScrollFrame)
    autoScrollFrame = null
  }

  /** 現在のウィンドウでOSからのファイルドロップを購読する。 */
  function listenForNativeDrops(): void {
    nativeDropSetupCancelled = false
    void getCurrentWindow().onDragDropEvent(({ payload }) => handleNativeDropEvent(payload)).then((unlisten) => {
      if (nativeDropSetupCancelled) unlisten()
      else unlistenNativeDrop = unlisten
    }).catch((error: unknown) => {
      console.error('TXTのドロップを受け付けられません。', error)
    })
  }

  /** ウィンドウイベントとネイティブドロップ購読を解除し、自動スクロールを停止する。 */
  function dispose(): void {
    nativeDropSetupCancelled = true
    unlistenNativeDrop?.()
    unlistenNativeDrop = null
    window.removeEventListener('pointermove', trackPointerTreeDrag)
    window.removeEventListener('pointerup', finishPointerTreeDrag)
    window.removeEventListener('pointercancel', cancelPointerTreeDrag)
    clearDragState()
  }

  onMounted(() => {
    window.addEventListener('pointermove', trackPointerTreeDrag, { passive: false })
    window.addEventListener('pointerup', finishPointerTreeDrag)
    window.addEventListener('pointercancel', cancelPointerTreeDrag)
    listenForNativeDrops()
  })
  onBeforeUnmount(dispose)

  return {
    treeScrollElement,
    dragNodeId,
    dropIndicator,
    externalDropActive,
    startPointerTreeDrag,
    cancelPointerTreeDrag,
    shouldSuppressGeneratedClick,
  }
}
