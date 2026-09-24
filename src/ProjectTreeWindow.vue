<!-- メイン画面とイベント同期して表示する分離プロジェクトツリー。 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import ProjectTreeSidebar from './ProjectTreeSidebar.vue'
import {
  PROJECT_TREE_WINDOW_COMMAND_EVENT,
  PROJECT_TREE_WINDOW_STATE_EVENT,
  type ProjectTreeOpenRequest,
  type ProjectTreeOpenResult,
  type ProjectTreeWindowCommandPayload,
  type ProjectTreeWindowState,
} from './projectTreeWindow'

const windowId = new URLSearchParams(window.location.search).get('windowId') ?? ''
const state = ref<ProjectTreeWindowState>({
  windowId,
  revision: 0,
  disabled: true,
  documentOrigin: null,
  expandedFolderIds: [],
  unavailableNodeIds: [],
})
let unlistenState: (() => void) | undefined
let unlistenClose: (() => void) | undefined
let pendingOpenRequestId: string | null = null
let dockAfterOpenRequest = false
const dockWaitingForOpenResult = ref(false)

/** ウィンドウIDを付けて要求を送信し、古い分離ウィンドウの操作と区別する。 */
async function sendCommand(command: ProjectTreeWindowCommandPayload): Promise<boolean> {
  if (!windowId) return false
  try {
    await emitTo('main', PROJECT_TREE_WINDOW_COMMAND_EVENT, { ...command, windowId })
    return true
  } catch (error) {
    console.error('プロジェクトツリーの要求を送信できませんでした。', error)
    return false
  }
}

/** 展開状態を手元にも反映し、直後の閉じる要求にも最新値を含める。 */
function publishExpandedFolders(nodeIds: number[]): void {
  state.value = { ...state.value, expandedFolderIds: nodeIds }
  void sendCommand({ type: 'expanded-change', nodeIds })
}

/** 参照切れ状態をメイン画面へ同期し、ドック後も警告を維持する。 */
function publishUnavailableNodes(nodeIds: number[]): void {
  state.value = { ...state.value, unavailableNodeIds: nodeIds }
  void sendCommand({ type: 'unavailable-change', nodeIds })
}

/** ボタン操作に最新の展開状態を添えて元の画面へ戻す。 */
async function requestDock(): Promise<void> {
  if (pendingOpenRequestId) {
    dockAfterOpenRequest = true
    dockWaitingForOpenResult.value = true
    return
  }
  dockAfterOpenRequest = false
  dockWaitingForOpenResult.value = false
  const sent = await sendCommand({
    type: 'dock',
    expandedFolderIds: state.value.expandedFolderIds,
    unavailableNodeIds: state.value.unavailableNodeIds,
  })
  if (!sent) {
    try {
      await getCurrentWindow().destroy()
    } catch (error) {
      console.error('プロジェクトツリーを閉じられませんでした。', error)
    }
  }
}

/** ×をドック操作として扱い、開く処理中なら結果の適用後まで保留する。 */
function requestDockOnClose(event: { preventDefault: () => void }): void {
  event.preventDefault()
  void requestDock()
}

/** メイン画面の新しい状態だけを適用し、古いイベントによる巻き戻りを防ぐ。 */
function receiveState(next: ProjectTreeWindowState): void {
  if (next.windowId !== windowId || next.revision <= state.value.revision) return
  state.value = next
}

/** メイン画面へファイル操作を依頼し、送信失敗時もツリーの処理中表示を解除する。 */
async function requestOpenFile(request: ProjectTreeOpenRequest): Promise<void> {
  if (pendingOpenRequestId) return
  pendingOpenRequestId = request.requestId
  if (await sendCommand({ type: 'open-file', request })) return
  if (pendingOpenRequestId !== request.requestId) return
  const openResult: ProjectTreeOpenResult = {
    requestId: request.requestId,
    nodeId: request.nodeId,
    error: 'メイン画面へ接続できないため、ファイルを開けませんでした。',
  }
  state.value = { ...state.value, openResult }
}

/** サイドバーが結果表示まで完了したことを受け、保留中のドックを実行する。 */
async function handleOpenResultApplied(requestId: string): Promise<void> {
  if (pendingOpenRequestId !== requestId) return
  await sendCommand({ type: 'open-result-applied', requestId })
  pendingOpenRequestId = null
  if (dockAfterOpenRequest) void requestDock()
}

onMounted(async () => {
  if (!windowId) return
  unlistenState = await listen<ProjectTreeWindowState>(PROJECT_TREE_WINDOW_STATE_EVENT, (event) => {
    receiveState(event.payload)
  })
  unlistenClose = await getCurrentWindow().onCloseRequested(requestDockOnClose)
  await sendCommand({ type: 'ready' })
})

onBeforeUnmount(() => {
  unlistenState?.()
  unlistenClose?.()
})
</script>

<template>
  <VApp class="project-tree-window-shell">
    <ProjectTreeSidebar
      v-if="windowId"
      :disabled="state.disabled"
      :document-origin="state.documentOrigin"
      :expanded-folder-ids="state.expandedFolderIds"
      :unavailable-node-ids="state.unavailableNodeIds"
      :open-result="state.openResult"
      detached
      @detach-request="requestDock"
      @open-file="requestOpenFile"
      @open-result-applied="handleOpenResultApplied"
      @origin-detached="sendCommand({ type: 'origin-detached', nodeId: $event })"
      @expanded-change="publishExpandedFolders"
      @unavailable-change="publishUnavailableNodes"
    />
    <div v-else class="project-tree-window-error" role="alert">プロジェクトツリーを開けません。メイン画面からもう一度開いてください。</div>
    <VSnackbar v-model="dockWaitingForOpenResult" :timeout="-1" location="bottom">
      ファイルを開く処理の完了後に、メイン画面へ戻ります。
    </VSnackbar>
  </VApp>
</template>
