<!-- 保存先の異なる TXT と仮想フォルダを、実ファイルを動かさず管理する。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { message } from '@tauri-apps/plugin-dialog'
import { fileName } from './textFile'
import type { ProjectTreeOpenRequest, ProjectTreeOpenResult } from './projectTreeWindow'
import type { ProjectTreeNode, ProjectTreeSnapshot } from './projectTreeModel'
import { moveProjectNode, loadProjectTreeSnapshot } from './projectTreeClient'
import ProjectMenu from './ProjectMenu.vue'
import ProjectNameDialog from './ProjectNameDialog.vue'
import { useProjectTreeActions } from './useProjectTreeActions'
import { useProjectTreeDragAndDrop } from './useProjectTreeDragAndDrop'
import { useProjectTreeSelection } from './useProjectTreeSelection'
import { useProjectTreeStore } from './useProjectTreeStore'

type DocumentOrigin = { nodeId: number; projectId: number }

const props = withDefaults(defineProps<{
  disabled: boolean
  documentOrigin: DocumentOrigin | null
  expandedFolderIds?: number[]
  unavailableNodeIds?: number[]
  openResult?: ProjectTreeOpenResult | null
  detached?: boolean
}>(), {
  expandedFolderIds: () => [],
  unavailableNodeIds: () => [],
  openResult: null,
  detached: false,
})

const emit = defineEmits<{
  'open-file': [request: ProjectTreeOpenRequest]
  'open-result-applied': [requestId: string]
  'origin-detached': [nodeId: number]
  'expanded-change': [nodeIds: number[]]
  'unavailable-change': [nodeIds: number[]]
  'detach-request': []
}>()

const pendingOpenRequest = ref<ProjectTreeOpenRequest | null>(null)
const projectMenuOpen = ref(false)
const nodeMenuActivator = ref<HTMLElement | null>(null)
const nodeMenuList = ref<{ focus: (location: 'first') => void } | null>(null)
let nodeMenuOpenedWithKeyboard = false
type SelectionController = ReturnType<typeof useProjectTreeSelection>
type ActionsController = ReturnType<typeof useProjectTreeActions>
let selectionController: SelectionController | null = null
let isDialogOpen = (): boolean => false
let requestNodeRemove = (): void => {}
let closeNodeMenu = (): void => {}

/** DBから受け取ったツリーを選択状態へ反映し、文書の出自だけSidebarで同期する。 */
function handleSnapshotRefreshed(nextSnapshot: ProjectTreeSnapshot): void {
  selectionController?.handleSnapshotRefreshed(nextSnapshot)
  if (props.documentOrigin && !nextSnapshot.projects.some((project) => project.id === props.documentOrigin?.projectId)) {
    emit('origin-detached', props.documentOrigin.nodeId)
  }
}

/** ツリー操作の失敗を利用者へ通知する。 */
async function showTreeError(error: unknown): Promise<void> {
  await message(`プロジェクトツリーを更新できませんでした。\n${String(error)}`, {
    title: 'プロジェクトツリー',
    kind: 'error',
  })
}

const store = useProjectTreeStore({
  loadSnapshot: loadProjectTreeSnapshot,
  canMutate: () => !props.disabled && !pendingOpenRequest.value,
  showError: showTreeError,
  onSnapshotRefreshed: handleSnapshotRefreshed,
})
const {
  snapshot,
  loading,
  mutationPending,
  delayedProgress,
  treeError,
  initializeTree,
  runMutation,
} = store

const selection = useProjectTreeSelection({
  snapshot,
  expandedFolderIds: props.expandedFolderIds,
  unavailableNodeIds: props.unavailableNodeIds,
  onExpandedChange: (nodeIds) => emit('expanded-change', nodeIds),
  onUnavailableChange: (nodeIds) => emit('unavailable-change', nodeIds),
  isDialogOpen: () => isDialogOpen() || nodeMenuOpen.value,
  isBusy: () => isBusy.value,
  onActivateNode: (node) => { void activateNode(node) },
  onFocusNode: (nodeId, restoreOnly) => { void focusTreeNode(nodeId, restoreOnly) },
  onDeleteSelection: () => requestNodeRemove(),
  onEscape: () => closeNodeMenu(),
})
selectionController = selection

const activeProject = computed(() => snapshot.value.projects.find((project) => project.id === snapshot.value.activeProjectId) ?? null)
const currentOriginProject = computed(() => props.documentOrigin
  ? snapshot.value.projects.find((project) => project.id === props.documentOrigin?.projectId) ?? null
  : null)
const showOriginNotice = computed(() => Boolean(
  props.documentOrigin && currentOriginProject.value && currentOriginProject.value.id !== snapshot.value.activeProjectId,
))
const selectedNodes = computed(() => snapshot.value.nodes.filter((node) => selection.selectedNodeIds.value.has(node.id)
  && node.projectId === snapshot.value.activeProjectId))
const isBusy = computed(() => props.disabled || loading.value || mutationPending.value || Boolean(treeError.value) || Boolean(pendingOpenRequest.value))

const actions = useProjectTreeActions({
  snapshot,
  pendingOpenRequest,
  documentOrigin: () => props.documentOrigin,
  selectedNodes: () => selectedNodes.value,
  unavailableNodeIds: () => [...selection.unavailableNodes.value],
  isBusy: () => isBusy.value,
  runMutation,
  showTreeError,
  setUnavailableNodeIds: (nodeIds) => selection.setUnavailableNodeIds(nodeIds),
  clearNodeSelection: selection.clearNodeSelection,
  selectNodeFromContextMenu: selection.selectNodeFromContextMenu,
  expandFolderPath: selection.expandFolderPath,
  containsNode: selection.containsNode,
  onOpenFile: (request) => emit('open-file', request),
  onOpenResultApplied: (requestId) => emit('open-result-applied', requestId),
  onOriginDetached: (nodeId) => emit('origin-detached', nodeId),
})
const actionController: ActionsController = actions
isDialogOpen = () => actionController.dialogOpen.value || actionController.projectDialogOpen.value
requestNodeRemove = () => { void actionController.requestNodeRemove() }
closeNodeMenu = () => { actionController.nodeMenuOpen.value = false }

const {
  expandedFolders,
  unavailableNodes,
  selectedNodeIds,
  focusedNodeId,
  setFocusedNode,
  visibleRows,
  setNodeSelection,
  selectNodeFromClick,
  toggleFolder,
  handleTreeKeydown,
  handleTreeBackgroundClick,
} = selection
const {
  contextNode,
  contextTarget,
  nodeMenuOpen,
  nodeMenuTarget,
  dialogOpen,
  dialogTitle,
  dialogValue,
  saveNameDialog,
  changeProject,
  requestProjectCreate,
  requestProjectRename,
  requestProjectDelete,
  projectDialogOpen,
  projectDialogTitle,
  projectDialogValue,
  saveProjectDialog,
  registerFile,
  registerDroppedFiles,
  requestFolderCreate,
  openNameDialog,
  openNodeMenu: openNodeMenuAction,
  openRootMenu: openRootMenuAction,
  openTreeFile,
  applyOpenResult,
  requestRelink,
} = actions

const {
  treeScrollElement,
  dragNodeId,
  dropIndicator,
  externalDropActive,
  startPointerTreeDrag,
  cancelPointerTreeDrag,
  shouldSuppressGeneratedClick,
} = useProjectTreeDragAndDrop({
  snapshot,
  isBusy: () => isBusy.value,
  setNodeSelection,
  runMutation,
  moveProjectNode,
  registerDroppedFiles,
})
// テンプレートの ref 属性から composable が所有するスクロール要素へ接続する。
void treeScrollElement

/** 更新後の行を画面内へ移す。復帰時はツリー外の操作へフォーカスを奪わない。 */
async function focusTreeNode(nodeId: number | null, restoreOnly: boolean): Promise<void> {
  const tree = treeScrollElement.value
  if (!tree || isDialogOpen() || (restoreOnly && !tree.contains(document.activeElement))) return
  const previousElement = document.activeElement
  await nextTick()
  if (!tree.isConnected || isDialogOpen() || focusedNodeId.value !== nodeId) return
  if (document.activeElement !== previousElement && document.activeElement !== document.body
    && !tree.contains(document.activeElement)) return
  const button = nodeId === null ? null : tree.querySelector<HTMLButtonElement>(`[data-node-id="${nodeId}"] .project-tree-main`)
  const target = button && !button.disabled ? button : tree
  target.focus({ preventScroll: true })
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/** キーボード起動の操作メニューは座標0ではなく、操作した行ボタンの直下へ開く。 */
function openNodeMenu(event: MouseEvent, node: ProjectTreeNode): void {
  nodeMenuOpenedWithKeyboard = event.detail === 0 && event.clientX === 0 && event.clientY === 0
  nodeMenuActivator.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  openNodeMenuAction(event, node)
  if (!nodeMenuOpenedWithKeyboard || !nodeMenuActivator.value) return
  const bounds = nodeMenuActivator.value.getBoundingClientRect()
  nodeMenuTarget.value = [bounds.left, bounds.bottom]
}

/** キーボードで開いたメニューは、描画完了後にVuetifyの一覧ナビゲーションへ渡す。 */
function focusNodeMenu(): void {
  if (!nodeMenuOpen.value || !nodeMenuOpenedWithKeyboard || isDialogOpen()) return
  nodeMenuList.value?.focus('first')
}

/** ファイル・フォルダ行を選択し、ファイルなら既存エディターで開く要求を送る。 */
async function activateNode(node: ProjectTreeNode): Promise<void> {
  if (isBusy.value) return
  if (node.kind === 'folder') {
    toggleFolder(node.id)
    return
  }
  await openTreeFile(node)
}

/** ドラッグ直後の合成クリックだけを抑え、通常クリックではノードを開く。 */
function activateNodeFromClick(event: MouseEvent, node: ProjectTreeNode): void {
  if (shouldSuppressGeneratedClick(event.detail)) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  if (selectNodeFromClick(event, node)) return
  void activateNode(node)
}

/** 行以外のツリー空欄を現在プロジェクトのルートとして右クリックする。 */
function openRootMenu(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.project-tree-row')) return
  nodeMenuOpenedWithKeyboard = false
  nodeMenuActivator.value = null
  openRootMenuAction(event)
}

/** 別プロジェクト由来の文書を開いている場合、そのプロジェクトを表示する。 */
async function returnToOriginProject(): Promise<void> {
  if (!currentOriginProject.value) return
  await changeProject(currentOriginProject.value.id)
}

onMounted(async () => {
  await store.setup()
  await initializeTree()
})
onBeforeUnmount(() => {
  store.dispose()
})
watch(() => props.expandedFolderIds, (folderIds) => {
  selection.syncExpandedFolderIds(folderIds)
}, { deep: true, immediate: true })
watch(() => props.unavailableNodeIds, (nodeIds) => {
  selection.syncUnavailableNodeIds(nodeIds)
}, { deep: true, immediate: true })
watch(() => props.openResult, (result) => { void applyOpenResult(result) })
watch(isBusy, (busy) => {
  const tree = treeScrollElement.value
  if (!tree || !tree.contains(document.activeElement)) return
  // 操作中のbutton無効化でフォーカスがbodyへ落ちるのを防ぎ、完了後に現在行へ戻す。
  if (busy) tree.focus({ preventScroll: true })
  else void focusTreeNode(focusedNodeId.value, true)
}, { flush: 'sync' })
</script>

<template>
  <aside class="project-tree-sidebar" :class="{ 'is-reordering': dragNodeId !== null }" aria-label="プロジェクトツリー">
    <header class="project-tree-header">
      <div class="project-tree-heading-row">
        <VTooltip :text="activeProject?.name ?? 'プロジェクトなし'" location="bottom">
          <template #activator="{ props: tooltipProps }">
            <span v-bind="tooltipProps" class="project-tree-heading" :class="{ 'is-empty': !activeProject }">{{ activeProject?.name ?? 'プロジェクトなし' }}</span>
          </template>
        </VTooltip>
        <VTooltip text="フォルダを追加" location="bottom">
          <template #activator="{ props: tooltipProps }">
            <VBtn v-bind="tooltipProps" class="project-tree-header-action" icon size="small" variant="text" aria-label="フォルダを追加" title="フォルダを追加" :disabled="isBusy || !activeProject" @click="requestFolderCreate()">
              <VIcon icon="mdi-folder-plus-outline" aria-hidden="true" />
            </VBtn>
          </template>
        </VTooltip>
        <VTooltip text="TXTを登録" location="bottom">
          <template #activator="{ props: tooltipProps }">
            <VBtn v-bind="tooltipProps" class="project-tree-header-action" icon size="small" variant="text" aria-label="TXTを登録" title="TXTを登録" :disabled="isBusy || !activeProject" @click="registerFile()">
              <VIcon icon="mdi-file-plus-outline" aria-hidden="true" />
            </VBtn>
          </template>
        </VTooltip>
        <ProjectMenu
          v-model="projectMenuOpen"
          :projects="snapshot.projects"
          :active-project-id="snapshot.activeProjectId"
          :disabled="isBusy"
          @create="requestProjectCreate"
          @select="changeProject"
          @rename="requestProjectRename"
          @delete="requestProjectDelete"
        />
        <VTooltip :text="detached ? 'メイン画面へ戻す' : '別ウィンドウで表示'" location="bottom">
          <template #activator="{ props: tooltipProps }">
            <VBtn v-bind="tooltipProps" class="project-tree-detach" icon size="small" variant="text" :aria-label="detached ? 'メイン画面へ戻す' : '別ウィンドウで表示'" :title="detached ? 'メイン画面へ戻す' : '別ウィンドウで表示'" @click="emit('detach-request')">
              <VIcon :icon="detached ? 'mdi-dock-left' : 'mdi-dock-window'" aria-hidden="true" />
            </VBtn>
          </template>
        </VTooltip>
      </div>
    </header>

    <div v-if="showOriginNotice" class="project-tree-origin" role="status">
      <span>開いている文書: {{ currentOriginProject?.name }}</span>
      <VBtn size="x-small" variant="text" @click="returnToOriginProject">元のツリーを表示</VBtn>
    </div>

    <VProgressLinear v-if="delayedProgress" class="project-tree-progress" indeterminate color="primary" height="2" />
    <p v-if="treeError" class="project-tree-error" role="alert">ツリーを読み込めませんでした。{{ treeError }}</p>
    <VBtn v-if="treeError" class="project-tree-retry" size="small" variant="text" prepend-icon="mdi-refresh" @click="initializeTree">再読み込み</VBtn>
    <div v-else-if="loading" class="project-tree-empty" role="status">ツリーを読み込み中…</div>
    <div v-else-if="snapshot.projects.length === 0" class="project-tree-empty">
      <p>プロジェクトはまだありません。</p>
      <VBtn size="small" variant="tonal" prepend-icon="mdi-plus" @click="requestProjectCreate">作成</VBtn>
    </div>
    <div
      ref="treeScrollElement"
      class="project-tree-scroll"
      :class="{ 'external-drop-active': externalDropActive }"
      role="tree"
      aria-label="ファイルと仮想フォルダ"
      aria-multiselectable="true"
      :tabindex="visibleRows.length === 0 || isBusy ? 0 : -1"
      :aria-busy="isBusy"
      @keydown="handleTreeKeydown"
      @click="handleTreeBackgroundClick"
      @contextmenu="openRootMenu"
    >
      <div v-if="snapshot.activeProjectId === null" class="project-tree-empty">プロジェクトを選択してください。</div>
      <template v-else>
        <div v-if="visibleRows.length === 0" class="project-tree-empty">ファイルやフォルダを登録してください。</div>
        <div
          v-for="row in visibleRows"
          :key="row.node.id"
          class="project-tree-row"
          :class="{
            'is-active': documentOrigin?.nodeId === row.node.id,
            'is-selected': selectedNodeIds.has(row.node.id),
            'is-unavailable': unavailableNodes.has(row.node.id),
            'drop-before': dropIndicator?.nodeId === row.node.id && dropIndicator.placement === 'before',
            'drop-after': dropIndicator?.nodeId === row.node.id && dropIndicator.placement === 'after',
            'drop-inside': dropIndicator?.nodeId === row.node.id && dropIndicator.placement === 'inside',
          }"
          :style="{ paddingInlineStart: `${8 + row.depth * 18}px` }"
          :data-node-id="row.node.id"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-expanded="row.node.kind === 'folder' ? expandedFolders.has(row.node.id) : undefined"
          :aria-selected="selectedNodeIds.has(row.node.id)"
          :aria-current="documentOrigin?.nodeId === row.node.id ? 'true' : undefined"
          @focusin="setFocusedNode(row.node.id)"
          @contextmenu="openNodeMenu($event, row.node)"
        >
          <button
            class="project-tree-main"
            type="button"
            :disabled="isBusy"
            :tabindex="focusedNodeId === row.node.id ? 0 : -1"
            @pointerdown="startPointerTreeDrag($event, row.node)"
            @lostpointercapture="cancelPointerTreeDrag"
            @click="activateNodeFromClick($event, row.node)"
          >
            <VIcon
              v-if="row.node.kind === 'folder'"
              class="project-tree-expand"
              :icon="expandedFolders.has(row.node.id) ? 'mdi-chevron-down' : 'mdi-chevron-right'"
              aria-hidden="true"
            />
            <span v-else class="project-tree-expand-spacer" aria-hidden="true" />
            <VIcon
              class="project-tree-node-icon"
              :icon="row.node.kind === 'folder' ? (expandedFolders.has(row.node.id) ? 'mdi-folder-open-outline' : 'mdi-folder-outline') : 'mdi-file-document-outline'"
              aria-hidden="true"
            />
            <span class="project-tree-node-name">{{ row.node.name || (row.node.path ? fileName(row.node.path) : '名前なし') }}</span>
            <VIcon v-if="unavailableNodes.has(row.node.id)" class="project-tree-warning" icon="mdi-alert-circle-outline" title="ファイルを開けません。再指定してください。" aria-label="ファイルを開けません" />
          </button>
          <VBtn class="project-tree-actions" icon size="x-small" variant="text" :disabled="isBusy" :tabindex="focusedNodeId === row.node.id ? 0 : -1" :aria-label="`${row.node.name} の操作`" @click="openNodeMenu($event, row.node)">
            <VIcon icon="mdi-dots-vertical" aria-hidden="true" />
          </VBtn>
        </div>
        <div
          class="project-tree-root-drop"
          :class="{ 'drop-root': dropIndicator?.nodeId === null }"
        >
          <span v-if="externalDropActive && dropIndicator?.nodeId === null">TXTをルートへ登録</span>
          <span v-else-if="visibleRows.length === 0">ここへTXTを登録</span>
          <span v-else>ルートの末尾へ移動 / TXTをルートへ登録</span>
        </div>
      </template>
    </div>

    <VMenu v-model="nodeMenuOpen" :activator="nodeMenuActivator ?? undefined" :open-on-click="false" :open-on-arrow="false" :target="nodeMenuTarget" location="bottom start" :close-on-content-click="true" @after-enter="focusNodeMenu">
      <VList v-if="contextNode" ref="nodeMenuList" density="compact" min-width="220" role="menu" aria-label="ノード操作">
        <template v-if="selectedNodes.length > 1">
          <VListItem role="menuitem" :title="`選択した${selectedNodes.length}件の登録を解除`" prepend-icon="mdi-delete-outline" @click="requestNodeRemove" />
        </template>
        <template v-else>
          <template v-if="contextNode.kind === 'folder'">
            <VListItem role="menuitem" title="中にフォルダを作成" prepend-icon="mdi-folder-plus-outline" @click="requestFolderCreate(contextNode.id)" />
            <VListItem role="menuitem" title="ここへ TXT を登録" prepend-icon="mdi-file-plus-outline" @click="registerFile(contextNode.id)" />
            <VListItem role="menuitem" title="フォルダ名を変更" prepend-icon="mdi-pencil-outline" @click="openNameDialog('folder-rename', '仮想フォルダ名を変更', contextNode.name, { nodeId: contextNode.id })" />
          </template>
          <VListItem v-else role="menuitem" title="エディターで開く" prepend-icon="mdi-file-edit-outline" @click="openTreeFile(contextNode)" />
          <VListItem v-if="contextNode.kind === 'file'" role="menuitem" title="参照先を再指定" prepend-icon="mdi-link-variant" @click="requestRelink" />
          <VDivider class="my-1" />
          <VListItem role="menuitem" title="登録を解除" prepend-icon="mdi-delete-outline" @click="requestNodeRemove" />
        </template>
      </VList>
      <VList v-else-if="contextTarget.kind === 'root'" density="compact" min-width="220" role="menu" aria-label="ルート操作">
        <VListItem role="menuitem" title="フォルダを追加" prepend-icon="mdi-folder-plus-outline" @click="requestFolderCreate()" />
        <VListItem role="menuitem" title="TXTを登録" prepend-icon="mdi-file-plus-outline" @click="registerFile()" />
      </VList>
    </VMenu>

    <ProjectNameDialog
      v-model="projectDialogOpen"
      :title="projectDialogTitle"
      :value="projectDialogValue"
      :disabled="isBusy"
      @update:value="projectDialogValue = $event"
      @save="saveProjectDialog"
    />

    <ProjectNameDialog
      v-model="dialogOpen"
      :title="dialogTitle"
      :value="dialogValue"
      :disabled="isBusy"
      @update:value="dialogValue = $event"
      @save="saveNameDialog"
    />
  </aside>
</template>
