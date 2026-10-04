/** プロジェクトツリーの展開、選択、表示行、キーボード操作を画面構成から分離する。 */
import { computed, ref, watch, type Ref } from 'vue'
import {
  projectTreeSelectionAfterClick,
  projectTreeSelectionAfterContextMenu,
  projectTreeSelectionForNodes,
  type ProjectTreeNode,
  type ProjectTreeSnapshot,
} from './projectTreeModel'

type VisibleProjectTreeRow = { node: ProjectTreeNode; depth: number }

type ProjectTreeSelectionOptions = {
  snapshot: Ref<ProjectTreeSnapshot>
  expandedFolderIds: number[]
  unavailableNodeIds: number[]
  onExpandedChange: (nodeIds: number[]) => void
  onUnavailableChange: (nodeIds: number[]) => void
  isDialogOpen: () => boolean
  isBusy: () => boolean
  onActivateNode: (node: ProjectTreeNode) => void
  onFocusNode: (nodeId: number | null, restoreOnly: boolean) => void
  onDeleteSelection: () => void
  onEscape: () => void
}

/** 展開・選択状態を保持し、再読込時に現在のツリーへ選択を同期する。 */
export function useProjectTreeSelection(options: ProjectTreeSelectionOptions) {
  const expandedFolders = ref(new Set<number>(options.expandedFolderIds))
  const unavailableNodes = ref(new Set<number>(options.unavailableNodeIds))
  const selectedNodeIds = ref(new Set<number>())
  const selectionAnchorNodeId = ref<number | null>(null)
  const focusedNodeId = ref<number | null>(null)

  /** 保存順を保ったまま、選択中プロジェクトの展開済み行を階層順に並べる。 */
  const visibleRows = computed<VisibleProjectTreeRow[]>(() => {
    const children = new Map<number | null, ProjectTreeNode[]>()
    for (const node of options.snapshot.value.nodes) {
      if (node.projectId !== options.snapshot.value.activeProjectId) continue
      const group = children.get(node.parentId) ?? []
      group.push(node)
      children.set(node.parentId, group)
    }

    const rows: VisibleProjectTreeRow[] = []
    const appendChildren = (parentId: number | null, depth: number): void => {
      for (const node of children.get(parentId) ?? []) {
        rows.push({ node, depth })
        if (node.kind === 'folder' && expandedFolders.value.has(node.id)) appendChildren(node.id, depth + 1)
      }
    }
    appendChildren(null, 0)
    return rows
  })

  // DOMの更新前に旧行を参照し、折りたたみ・削除後も親か近隣へ移れるようにする。
  watch(visibleRows, (rows, previousRows = []) => {
    if (rows.some((row) => row.node.id === focusedNodeId.value)) return
    const previousId = focusedNodeId.value
    const previousIndex = previousRows.findIndex((row) => row.node.id === previousId)
    const previousNodes = new Map(previousRows.map((row) => [row.node.id, row.node]))
    const visibleIds = new Set(rows.map((row) => row.node.id))
    let parentId = previousId === null ? null : previousNodes.get(previousId)?.parentId ?? null
    const visited = new Set<number>()
    while (parentId !== null && !visibleIds.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId)
      parentId = previousNodes.get(parentId)?.parentId ?? null
    }
    focusedNodeId.value = parentId !== null && visibleIds.has(parentId)
      ? parentId
      : rows[Math.min(Math.max(previousIndex, 0), rows.length - 1)]?.node.id ?? null
    pruneSelectionToVisibleRows()
    if (previousId !== null) options.onFocusNode(focusedNodeId.value, true)
  }, { flush: 'sync', immediate: true })

  /** 行ボタンへのフォーカスやクリックをTab移動先へ反映する。選択は変更しない。 */
  function setFocusedNode(nodeId: number): void {
    if (visibleRows.value.some((row) => row.node.id === nodeId)) focusedNodeId.value = nodeId
  }

  /** キーボード移動先へフォーカスし、修飾キーに応じて既存の範囲選択を適用する。 */
  function focusNode(nodeId: number, event: KeyboardEvent): void {
    const anchorId = selectionAnchorNodeId.value ?? focusedNodeId.value
    focusedNodeId.value = nodeId
    if (event.shiftKey || !(event.ctrlKey || event.metaKey)) {
      const change = projectTreeSelectionAfterClick(
        visibleRows.value.map((row) => row.node.id), selectedNodeIds.value, anchorId, nodeId,
        { ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey },
      )
      setNodeSelection(change.selectedNodeIds, change.anchorNodeId)
    }
    options.onFocusNode(nodeId, false)
  }

  /** ツリーの選択状態を置き換え、範囲選択の基準行も更新する。 */
  function setNodeSelection(nodeIds: number[], anchorNodeId: number | null = nodeIds.at(-1) ?? null): void {
    selectedNodeIds.value = new Set(nodeIds)
    selectionAnchorNodeId.value = anchorNodeId
  }

  /** ツリーの選択状態と範囲選択の基準行を空にする。 */
  function clearNodeSelection(): void {
    setNodeSelection([])
  }

  /** 折りたたみや再読込で表示されなくなったノードを選択から外す。 */
  function pruneSelectionToVisibleRows(): void {
    const visibleIds = new Set(visibleRows.value.map((row) => row.node.id))
    const nextIds = [...selectedNodeIds.value].filter((id) => visibleIds.has(id))
    if (nextIds.length === selectedNodeIds.value.size
      && (selectionAnchorNodeId.value === null || visibleIds.has(selectionAnchorNodeId.value))) return
    setNodeSelection(nextIds, selectionAnchorNodeId.value !== null && visibleIds.has(selectionAnchorNodeId.value)
      ? selectionAnchorNodeId.value
      : nextIds.at(-1) ?? null)
  }

  /** ツリーの表示行に対するクリック選択を適用する。 */
  function selectNodeFromClick(event: MouseEvent, node: ProjectTreeNode): boolean {
    setFocusedNode(node.id)
    const change = projectTreeSelectionAfterClick(
      visibleRows.value.map((row) => row.node.id),
      selectedNodeIds.value,
      selectionAnchorNodeId.value,
      node.id,
      { ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey },
    )
    setNodeSelection(change.selectedNodeIds, change.anchorNodeId)
    return event.ctrlKey || event.metaKey || event.shiftKey
  }

  /** 右クリック対象が未選択なら単独選択し、選択済みなら既存の選択を維持する。 */
  function selectNodeFromContextMenu(node: ProjectTreeNode): void {
    setFocusedNode(node.id)
    const change = projectTreeSelectionAfterContextMenu(
      visibleRows.value.map((row) => row.node.id),
      selectedNodeIds.value,
      node.id,
    )
    setNodeSelection(change.selectedNodeIds, change.anchorNodeId)
  }

  /** DBから受け取ったツリーを表示用選択状態へ反映する。 */
  function handleSnapshotRefreshed(nextSnapshot: ProjectTreeSnapshot): void {
    const validIds = new Set(nextSnapshot.nodes.map((node) => node.id))
    setUnavailableNodeIds([...unavailableNodes.value].filter((id) => validIds.has(id)))
    const validSelection = projectTreeSelectionForNodes(
      selectedNodeIds.value,
      nextSnapshot.nodes,
      nextSnapshot.activeProjectId,
    )
    // snapshot.value の更新後に visibleRows を参照すると、新しい階層に基づいて再計算される。
    const visibleIds = new Set(visibleRows.value.map((row) => row.node.id))
    const displayedSelection = validSelection.filter((id) => visibleIds.has(id))
    setNodeSelection(displayedSelection, displayedSelection.includes(selectionAnchorNodeId.value ?? -1)
      ? selectionAnchorNodeId.value
      : displayedSelection.at(-1) ?? null)
  }

  /** 親から受け取った展開状態を画面へ同期する。 */
  function syncExpandedFolderIds(folderIds: number[]): void {
    expandedFolders.value = new Set(folderIds)
    pruneSelectionToVisibleRows()
  }

  /** 親から受け取った参照切れ状態を画面へ同期する。 */
  function syncUnavailableNodeIds(nodeIds: number[]): void {
    unavailableNodes.value = new Set(nodeIds)
  }

  /** 参照切れ状態を更新し、必要な場合だけ親へ通知する。 */
  function setUnavailableNodeIds(nodeIds: number[], notify = true): void {
    const next = new Set(nodeIds)
    const current = unavailableNodes.value
    if (current.size === next.size && [...current].every((nodeId) => next.has(nodeId))) return
    unavailableNodes.value = next
    if (notify) options.onUnavailableChange([...next].sort((left, right) => left - right))
  }

  /** フォルダの展開状態を切り替える。 */
  function toggleFolder(nodeId: number): void {
    const next = new Set(expandedFolders.value)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    setExpandedFolders(next)
  }

  /** 展開状態を更新し、分離・復帰先へ渡す同期用スナップショットを送る。 */
  function setExpandedFolders(folderIds: Set<number>): void {
    expandedFolders.value = folderIds
    pruneSelectionToVisibleRows()
    options.onExpandedChange([...folderIds].sort((left, right) => left - right))
  }

  /** 追加先のフォルダと全ての祖先を展開し、新規項目がツリー上で見えるようにする。 */
  function expandFolderPath(folderId: number | null): void {
    const next = new Set(expandedFolders.value)
    const visited = new Set<number>()
    let currentId = folderId
    while (currentId !== null && !visited.has(currentId)) {
      visited.add(currentId)
      const folder = options.snapshot.value.nodes.find((node) => node.id === currentId)
      if (!folder || folder.kind !== 'folder') break
      next.add(folder.id)
      currentId = folder.parentId
    }
    setExpandedFolders(next)
  }

  /** ノード自身または仮想フォルダ配下に指定ノードがあるか調べる。 */
  function containsNode(parentId: number, candidateId: number): boolean {
    if (parentId === candidateId) return true
    let node = options.snapshot.value.nodes.find((item) => item.id === candidateId)
    while (node?.parentId !== null && node?.parentId !== undefined) {
      if (node.parentId === parentId) return true
      node = options.snapshot.value.nodes.find((item) => item.id === node?.parentId)
    }
    return false
  }

  /** 可視行の移動・展開・選択・起動を処理し、入力中や処理中の操作を抑止する。 */
  function handleTreeKeydown(event: KeyboardEvent): void {
    if (options.isDialogOpen() || options.isBusy() || event.isComposing || event.keyCode === 229 || event.altKey) return
    const target = typeof HTMLElement !== 'undefined' && event.target instanceof HTMLElement ? event.target : null
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"]')) return

    const rows = visibleRows.value
    const index = rows.findIndex((row) => row.node.id === focusedNodeId.value)
    const node = rows[index]?.node
    const control = event.ctrlKey || event.metaKey
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
        : event.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0)
      const nextNode = rows[nextIndex]?.node
      if (nextNode) focusNode(nextNode.id, event)
      return
    }
    if (node && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      event.preventDefault()
      if (event.key === 'ArrowRight') {
        const child = rows[index + 1]?.node
        if (node.kind === 'folder' && !expandedFolders.value.has(node.id)) toggleFolder(node.id)
        else if (child?.parentId === node.id) focusNode(child.id, event)
      } else if (node.kind === 'folder' && expandedFolders.value.has(node.id)) toggleFolder(node.id)
      else if (node.parentId !== null) focusNode(node.parentId, event)
      return
    }
    if (node && event.key === ' ' && control) {
      event.preventDefault()
      const ids = new Set(selectedNodeIds.value)
      if (ids.has(node.id)) ids.delete(node.id)
      else ids.add(node.id)
      setNodeSelection([...ids], node.id)
      return
    }
    if (node && event.key === 'Enter' && !control && !event.shiftKey
      && !target?.closest('.project-tree-actions')) {
      event.preventDefault()
      setNodeSelection([node.id])
      options.onActivateNode(node)
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      clearNodeSelection()
      options.onEscape()
      return
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      const ids = visibleRows.value.map((row) => row.node.id)
      setNodeSelection(ids, ids[0] ?? null)
      return
    }

    if (event.key === 'Delete' && selectedNodeIds.value.size > 0) {
      event.preventDefault()
      options.onDeleteSelection()
    }
  }

  /** 行以外のツリー空白をクリックしたときに選択を解除する。 */
  function handleTreeBackgroundClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest('.project-tree-row')) clearNodeSelection()
  }

  return {
    expandedFolders,
    unavailableNodes,
    selectedNodeIds,
    focusedNodeId,
    setFocusedNode,
    visibleRows,
    setNodeSelection,
    clearNodeSelection,
    selectNodeFromClick,
    selectNodeFromContextMenu,
    handleSnapshotRefreshed,
    syncExpandedFolderIds,
    syncUnavailableNodeIds,
    setUnavailableNodeIds,
    toggleFolder,
    expandFolderPath,
    containsNode,
    handleTreeKeydown,
    handleTreeBackgroundClick,
  }
}
