<!-- 保存先の異なる TXT と仮想フォルダを、実ファイルを動かさず管理する。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { chooseTextFile, fileName } from './textFile'
import {
  authorizeProjectFile,
  createProject,
  createProjectFolder,
  deleteProject,
  loadProjectTreeSnapshot,
  moveProjectNode,
  registerProjectFile,
  relinkProjectFile,
  removeProjectNode,
  renameProject,
  renameProjectFolder,
  selectProject,
  type ProjectTreeNode,
  type ProjectTreePlacement,
  type ProjectTreeSnapshot,
} from './projectTree'

type DocumentOrigin = { nodeId: number; projectId: number }
type DialogMode = 'project-create' | 'project-rename' | 'folder-create' | 'folder-rename'
type VisibleTreeRow = { node: ProjectTreeNode; depth: number }

const props = defineProps<{
  disabled: boolean
  documentOrigin: DocumentOrigin | null
}>()

const emit = defineEmits<{
  'open-file': [file: { nodeId: number; projectId: number; path: string }]
  'origin-detached': [nodeId: number]
}>()

const snapshot = ref<ProjectTreeSnapshot>({ projects: [], nodes: [], activeProjectId: null })
const loading = ref(true)
const mutationPending = ref(false)
const delayedProgress = ref(false)
const treeError = ref('')
const expandedFolders = ref(new Set<number>())
const unavailableNodes = ref(new Set<number>())
const dragNodeId = ref<number | null>(null)
const dropIndicator = ref<{ nodeId: number | null; placement: ProjectTreePlacement } | null>(null)
const nodeMenuOpen = ref(false)
const nodeMenuTarget = ref<[number, number]>([0, 0])
const contextNodeId = ref<number | null>(null)
const projectMenuOpen = ref(false)
const dialogOpen = ref(false)
const dialogMode = ref<DialogMode>('project-create')
const dialogTitle = ref('')
const dialogValue = ref('')
const dialogProjectId = ref<number | null>(null)
const dialogParentId = ref<number | null>(null)
const dialogNodeId = ref<number | null>(null)

const activeProject = computed(() => snapshot.value.projects.find((project) => project.id === snapshot.value.activeProjectId) ?? null)
const contextNode = computed(() => snapshot.value.nodes.find((node) => node.id === contextNodeId.value) ?? null)
const currentOriginProject = computed(() => props.documentOrigin
  ? snapshot.value.projects.find((project) => project.id === props.documentOrigin?.projectId) ?? null
  : null)
const showOriginNotice = computed(() => Boolean(
  props.documentOrigin && currentOriginProject.value && currentOriginProject.value.id !== snapshot.value.activeProjectId,
))
const isBusy = computed(() => props.disabled || loading.value || mutationPending.value || Boolean(treeError.value))

/** 保存順を保ったまま、選択中プロジェクトの展開済み行を階層順に並べる。 */
const visibleRows = computed<VisibleTreeRow[]>(() => {
  const children = new Map<number | null, ProjectTreeNode[]>()
  for (const node of snapshot.value.nodes) {
    if (node.projectId !== snapshot.value.activeProjectId) continue
    const group = children.get(node.parentId) ?? []
    group.push(node)
    children.set(node.parentId, group)
  }

  const rows: VisibleTreeRow[] = []
  const appendChildren = (parentId: number | null, depth: number): void => {
    for (const node of children.get(parentId) ?? []) {
      rows.push({ node, depth })
      if (node.kind === 'folder' && expandedFolders.value.has(node.id)) appendChildren(node.id, depth + 1)
    }
  }
  appendChildren(null, 0)
  return rows
})

/** DB から最新のツリーを読み込み、削除済みノードに対する一時エラーを整理する。 */
async function refreshSnapshot(): Promise<void> {
  snapshot.value = await loadProjectTreeSnapshot()
  const validIds = new Set(snapshot.value.nodes.map((node) => node.id))
  unavailableNodes.value = new Set([...unavailableNodes.value].filter((id) => validIds.has(id)))
  if (props.documentOrigin && !snapshot.value.projects.some((project) => project.id === props.documentOrigin?.projectId)) {
    emit('origin-detached', props.documentOrigin.nodeId)
  }
  treeError.value = ''
}

/** 初回表示時に保存済みプロジェクトとツリーを読み込む。 */
async function initializeTree(): Promise<void> {
  loading.value = true
  treeError.value = ''
  try {
    await refreshSnapshot()
  } catch (error) {
    treeError.value = String(error)
  } finally {
    loading.value = false
  }
}

/** DB 更新を直列化し、成功後に保存済み状態を再取得する。 */
async function runMutation(action: () => Promise<void>): Promise<boolean> {
  if (isBusy.value) return false
  mutationPending.value = true
  const progressTimer = setTimeout(() => { delayedProgress.value = true }, 250)
  let mutationSucceeded = false
  try {
    await action()
    mutationSucceeded = true
    await refreshSnapshot()
    return true
  } catch (error) {
    if (mutationSucceeded) treeError.value = String(error)
    await showTreeError(error)
    return false
  } finally {
    clearTimeout(progressTimer)
    delayedProgress.value = false
    mutationPending.value = false
  }
}

/** ツリー操作の失敗を利用者へ通知する。 */
async function showTreeError(error: unknown): Promise<void> {
  await message(`プロジェクトツリーを更新できませんでした。\n${String(error)}`, {
    title: 'プロジェクトツリー',
    kind: 'error',
  })
}

/** 入力ダイアログを開き、必要な対象 ID を保持する。 */
function openNameDialog(mode: DialogMode, title: string, initialValue: string, ids: { projectId?: number | null; parentId?: number | null; nodeId?: number | null } = {}): void {
  dialogMode.value = mode
  dialogTitle.value = title
  dialogValue.value = initialValue
  dialogProjectId.value = ids.projectId ?? null
  dialogParentId.value = ids.parentId ?? null
  dialogNodeId.value = ids.nodeId ?? null
  dialogOpen.value = true
}

/** 名前入力を検証し、対応するプロジェクトまたは仮想フォルダを保存する。 */
async function saveNameDialog(): Promise<void> {
  const name = dialogValue.value.trim()
  if (!name || isBusy.value) return
  const previousNodeIds = new Set(snapshot.value.nodes.map((node) => node.id))
  const previousProjectIds = new Set(snapshot.value.projects.map((project) => project.id))

  if (dialogMode.value === 'project-create') {
    if (!await runMutation(() => createProject(name))) return
    dialogOpen.value = false
    const created = snapshot.value.projects.find((project) => !previousProjectIds.has(project.id))
    if (created && snapshot.value.activeProjectId !== created.id) {
      await runMutation(() => selectProject(created.id))
    }
    return
  }

  let action: () => Promise<void>
  if (dialogMode.value === 'project-rename' && dialogProjectId.value !== null) {
    action = () => renameProject(dialogProjectId.value!, name)
  } else if (dialogMode.value === 'folder-create' && snapshot.value.activeProjectId !== null) {
    action = () => createProjectFolder(snapshot.value.activeProjectId!, dialogParentId.value, name)
  } else if (dialogMode.value === 'folder-rename' && dialogNodeId.value !== null) {
    action = () => renameProjectFolder(dialogNodeId.value!, name)
  } else {
    return
  }

  if (await runMutation(action)) {
    dialogOpen.value = false
    if (dialogMode.value === 'folder-create') {
      const createdFolder = snapshot.value.nodes.find((node) => !previousNodeIds.has(node.id)
        && node.kind === 'folder' && node.name === name
        && node.parentId === dialogParentId.value && node.projectId === snapshot.value.activeProjectId)
      if (createdFolder) expandFolderPath(createdFolder.id)
    }
  }
}

/** プロジェクト選択を保存してから表示を切り替える。 */
async function changeProject(projectId: number | null): Promise<void> {
  if (projectId === null || projectId === snapshot.value.activeProjectId) return
  await runMutation(() => selectProject(projectId))
}

/** 新しいプロジェクトを作成するための入力を求める。 */
function requestProjectCreate(): void {
  openNameDialog('project-create', 'プロジェクトを作成', '')
}

/** 選択中プロジェクト名の変更を求める。 */
function requestProjectRename(): void {
  if (!activeProject.value) return
  projectMenuOpen.value = false
  openNameDialog('project-rename', 'プロジェクト名を変更', activeProject.value.name, { projectId: activeProject.value.id })
}

/** 選択中プロジェクトと登録情報だけを確認後に削除する。 */
async function requestProjectDelete(): Promise<void> {
  const project = activeProject.value
  if (!project || isBusy.value) return
  projectMenuOpen.value = false
  if (!await ask(`「${project.name}」と配下の登録を削除します。実ファイルは削除されません。続けますか？`, {
    title: 'プロジェクトの削除', kind: 'warning', okLabel: '削除', cancelLabel: 'キャンセル',
  })) return

  const origin = props.documentOrigin
  if (await runMutation(() => deleteProject(project.id)) && origin?.projectId === project.id) {
    emit('origin-detached', origin.nodeId)
  }
}

/** ルートまたは選択フォルダへ TXT を登録する。選択ダイアログ取消時は状態を変えない。 */
async function registerFile(parentId: number | null = null): Promise<void> {
  const projectId = snapshot.value.activeProjectId
  if (projectId === null || isBusy.value) return
  const path = await chooseTextFile()
  if (!path) return
  if (await runMutation(() => registerProjectFile(projectId, parentId, path))) expandFolderPath(parentId)
}

/** ルートまたは指定フォルダへ仮想フォルダを作成する。 */
function requestFolderCreate(parentId: number | null = null): void {
  if (snapshot.value.activeProjectId === null) return
  nodeMenuOpen.value = false
  openNameDialog('folder-create', '仮想フォルダを作成', '', { parentId })
}

/** ノードの操作メニューをポインター位置へ開く。 */
function openNodeMenu(event: MouseEvent, node: ProjectTreeNode): void {
  event.preventDefault()
  event.stopPropagation()
  contextNodeId.value = node.id
  nodeMenuTarget.value = [event.clientX, event.clientY]
  nodeMenuOpen.value = true
}

/** ファイル・フォルダ行を選択し、ファイルなら既存エディターで開く要求を送る。 */
async function activateNode(node: ProjectTreeNode): Promise<void> {
  if (node.kind === 'folder') {
    toggleFolder(node.id)
    return
  }
  await openTreeFile(node)
}

/** 登録されたファイルの実在とアクセス許可を確認してからエディターへ渡す。 */
async function openTreeFile(node: ProjectTreeNode): Promise<void> {
  if (isBusy.value) return
  try {
    const path = await authorizeProjectFile(node.id)
    const next = new Set(unavailableNodes.value)
    next.delete(node.id)
    unavailableNodes.value = next
    emit('open-file', { nodeId: node.id, projectId: node.projectId, path })
  } catch (error) {
    unavailableNodes.value = new Set(unavailableNodes.value).add(node.id)
    await showTreeError(error)
  }
}

/** フォルダの展開状態を切り替える。 */
function toggleFolder(nodeId: number): void {
  const next = new Set(expandedFolders.value)
  if (next.has(nodeId)) next.delete(nodeId)
  else next.add(nodeId)
  expandedFolders.value = next
}

/** 追加先のフォルダと全ての祖先を展開し、新規項目がツリー上で見えるようにする。 */
function expandFolderPath(folderId: number | null): void {
  const next = new Set(expandedFolders.value)
  const visited = new Set<number>()
  let currentId = folderId
  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId)
    const folder = snapshot.value.nodes.find((node) => node.id === currentId)
    if (!folder || folder.kind !== 'folder') break
    next.add(folder.id)
    currentId = folder.parentId
  }
  expandedFolders.value = next
}

/** 選択ファイルを再指定し、成功後にそのノードの出自紐付けを解除する。 */
async function requestRelink(): Promise<void> {
  const node = contextNode.value
  if (!node || node.kind !== 'file' || isBusy.value) return
  nodeMenuOpen.value = false
  const path = await chooseTextFile()
  if (!path) return
  if (await runMutation(() => relinkProjectFile(node.id, path))) {
    const next = new Set(unavailableNodes.value)
    next.delete(node.id)
    unavailableNodes.value = next
    if (props.documentOrigin?.nodeId === node.id) emit('origin-detached', node.id)
  }
}

/** フォルダ配下を含む登録情報を確認後に削除し、対象文書の出自だけを解除する。 */
async function requestNodeRemove(): Promise<void> {
  const node = contextNode.value
  if (!node || isBusy.value) return
  nodeMenuOpen.value = false
  const label = node.kind === 'folder' ? '仮想フォルダと配下の登録' : 'ファイルの登録'
  if (!await ask(`「${node.name}」の${label}を削除します。実ファイルは削除されません。続けますか？`, {
    title: '登録の解除', kind: 'warning', okLabel: '登録解除', cancelLabel: 'キャンセル',
  })) return

  const originNodeId = props.documentOrigin?.nodeId
  const removeOrigin = originNodeId !== undefined && containsNode(node.id, originNodeId)
  if (await runMutation(() => removeProjectNode(node.id)) && removeOrigin) {
    emit('origin-detached', originNodeId)
  }
}

/** ノード自身または仮想フォルダ配下に指定ノードがあるか調べる。 */
function containsNode(parentId: number, candidateId: number): boolean {
  if (parentId === candidateId) return true
  let node = snapshot.value.nodes.find((item) => item.id === candidateId)
  while (node?.parentId !== null && node?.parentId !== undefined) {
    if (node.parentId === parentId) return true
    node = snapshot.value.nodes.find((item) => item.id === node?.parentId)
  }
  return false
}

/** ドロップ先ノードの位置から前・後・フォルダ内の挿入先を判定する。 */
function placementForDrop(event: DragEvent, node: ProjectTreeNode): ProjectTreePlacement {
  const row = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = (event.clientY - row.top) / Math.max(row.height, 1)
  if (node.kind === 'folder' && ratio >= 0.25 && ratio <= 0.75) return 'inside'
  return ratio < 0.5 ? 'before' : 'after'
}

/** ドラッグ元を記録し、別プロジェクトのドロップを防ぐ。 */
function startDrag(event: DragEvent, node: ProjectTreeNode): void {
  if (isBusy.value || !event.dataTransfer) {
    event.preventDefault()
    return
  }
  dragNodeId.value = node.id
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', String(node.id))
}

/** 行上の有効なドロップ位置を示す。 */
function showDropTarget(event: DragEvent, node: ProjectTreeNode): void {
  if (isBusy.value || dragNodeId.value === null || dragNodeId.value === node.id) return
  const placement = placementForDrop(event, node)
  if (placement === 'inside' && node.kind !== 'folder') return
  event.dataTransfer!.dropEffect = 'move'
  dropIndicator.value = { nodeId: node.id, placement }
}

/** 保存前に楽観更新せず、DB更新と最新ツリー取得が完了した後で並びを反映する。 */
async function dropOnNode(event: DragEvent, target: ProjectTreeNode): Promise<void> {
  const sourceId = dragNodeId.value
  if (sourceId === null || sourceId === target.id || isBusy.value) return
  const placement = placementForDrop(event, target)
  if (placement === 'inside' && target.kind !== 'folder') return
  clearDragState()
  await runMutation(() => moveProjectNode(sourceId, target.id, placement))
}

/** ルート末尾へノードを移動する。 */
async function dropAtRootEnd(): Promise<void> {
  const sourceId = dragNodeId.value
  if (sourceId === null || isBusy.value) return
  clearDragState()
  await runMutation(() => moveProjectNode(sourceId, null, 'root_end'))
}

/** ドラッグ終了時にドロップ表示と元ノードを初期化する。 */
function clearDragState(): void {
  dragNodeId.value = null
  dropIndicator.value = null
}

/** 別プロジェクト由来の文書を開いている場合、そのプロジェクトを表示する。 */
async function returnToOriginProject(): Promise<void> {
  if (!currentOriginProject.value) return
  await changeProject(currentOriginProject.value.id)
}

onMounted(() => { void initializeTree() })
</script>

<template>
  <aside class="project-tree-sidebar" aria-label="プロジェクトツリー">
    <header class="project-tree-header">
      <div class="project-tree-heading">プロジェクト</div>
      <div class="project-tree-project-row">
        <VSelect
          class="project-tree-select"
          :model-value="snapshot.activeProjectId"
          :items="snapshot.projects"
          item-title="name"
          item-value="id"
          density="compact"
          variant="outlined"
          hide-details
          :disabled="isBusy || snapshot.projects.length === 0"
          aria-label="表示するプロジェクト"
          placeholder="プロジェクトを選択"
          @update:model-value="changeProject"
        />
        <VBtn icon size="small" variant="text" aria-label="プロジェクトを作成" title="プロジェクトを作成" :disabled="isBusy" @click="requestProjectCreate">
          <VIcon icon="mdi-plus" aria-hidden="true" />
        </VBtn>
        <VMenu v-model="projectMenuOpen" location="bottom end" :disabled="isBusy || !activeProject">
          <template #activator="{ props: menuProps }">
            <VBtn v-bind="menuProps" icon size="small" variant="text" aria-label="プロジェクト操作" title="プロジェクト操作" :disabled="isBusy || !activeProject">
              <VIcon icon="mdi-dots-vertical" aria-hidden="true" />
            </VBtn>
          </template>
          <VList density="compact" min-width="190" role="menu" aria-label="プロジェクト操作">
            <VListItem role="menuitem" title="名前を変更" prepend-icon="mdi-pencil-outline" @click="requestProjectRename" />
            <VListItem role="menuitem" title="プロジェクトを削除" prepend-icon="mdi-delete-outline" @click="requestProjectDelete" />
          </VList>
        </VMenu>
      </div>
      <div class="project-tree-toolbar">
        <VBtn size="x-small" variant="text" prepend-icon="mdi-folder-plus-outline" :disabled="isBusy || !activeProject" @click="requestFolderCreate()">フォルダ</VBtn>
        <VBtn size="x-small" variant="text" prepend-icon="mdi-file-plus-outline" :disabled="isBusy || !activeProject" @click="registerFile()">TXTを登録</VBtn>
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
    <div v-else class="project-tree-scroll" role="tree" aria-label="ファイルと仮想フォルダ">
      <div v-if="snapshot.activeProjectId === null" class="project-tree-empty">プロジェクトを選択してください。</div>
      <template v-else>
        <div v-if="visibleRows.length === 0" class="project-tree-empty">ファイルやフォルダを登録してください。</div>
        <div
          v-for="row in visibleRows"
          :key="row.node.id"
          class="project-tree-row"
          :class="{
            'is-active': documentOrigin?.nodeId === row.node.id,
            'is-unavailable': unavailableNodes.has(row.node.id),
            'drop-before': dropIndicator?.nodeId === row.node.id && dropIndicator.placement === 'before',
            'drop-after': dropIndicator?.nodeId === row.node.id && dropIndicator.placement === 'after',
            'drop-inside': dropIndicator?.nodeId === row.node.id && dropIndicator.placement === 'inside',
          }"
          :style="{ paddingInlineStart: `${8 + row.depth * 18}px` }"
          :draggable="!isBusy"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-expanded="row.node.kind === 'folder' ? expandedFolders.has(row.node.id) : undefined"
          :aria-current="documentOrigin?.nodeId === row.node.id ? 'true' : undefined"
          @dragstart="startDrag($event, row.node)"
          @dragend="clearDragState"
          @dragover.prevent="showDropTarget($event, row.node)"
          @drop.prevent.stop="dropOnNode($event, row.node)"
          @contextmenu="openNodeMenu($event, row.node)"
        >
          <button class="project-tree-main" type="button" :disabled="isBusy" @click="activateNode(row.node)">
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
          <VBtn class="project-tree-actions" icon size="x-small" variant="text" :disabled="isBusy" :aria-label="`${row.node.name} の操作`" @click="openNodeMenu($event, row.node)">
            <VIcon icon="mdi-dots-vertical" aria-hidden="true" />
          </VBtn>
        </div>
        <div
          class="project-tree-root-drop"
          :class="{ 'drop-root': dropIndicator?.nodeId === null }"
          @dragover.prevent="!isBusy && dragNodeId !== null ? (dropIndicator = { nodeId: null, placement: 'root_end' }) : undefined"
          @drop.prevent.stop="dropAtRootEnd"
        >
          <span v-if="visibleRows.length === 0">ここへファイルをドロップ</span>
          <span v-else>ルートの末尾へ移動</span>
        </div>
      </template>
    </div>

    <VMenu v-model="nodeMenuOpen" :target="nodeMenuTarget" location="bottom start" :close-on-content-click="true">
      <VList v-if="contextNode" density="compact" min-width="220" role="menu" aria-label="ノード操作">
        <template v-if="contextNode.kind === 'folder'">
          <VListItem role="menuitem" title="中にフォルダを作成" prepend-icon="mdi-folder-plus-outline" @click="requestFolderCreate(contextNode.id)" />
          <VListItem role="menuitem" title="ここへ TXT を登録" prepend-icon="mdi-file-plus-outline" @click="registerFile(contextNode.id)" />
          <VListItem role="menuitem" title="フォルダ名を変更" prepend-icon="mdi-pencil-outline" @click="openNameDialog('folder-rename', '仮想フォルダ名を変更', contextNode.name, { nodeId: contextNode.id })" />
        </template>
        <VListItem v-else role="menuitem" title="エディターで開く" prepend-icon="mdi-file-edit-outline" @click="openTreeFile(contextNode)" />
        <VListItem v-if="contextNode.kind === 'file'" role="menuitem" title="参照先を再指定" prepend-icon="mdi-link-variant" @click="requestRelink" />
        <VDivider class="my-1" />
        <VListItem role="menuitem" title="登録を解除" prepend-icon="mdi-delete-outline" @click="requestNodeRemove" />
      </VList>
    </VMenu>

    <VDialog v-model="dialogOpen" max-width="420" @keydown.enter="saveNameDialog">
      <VCard>
        <VCardTitle>{{ dialogTitle }}</VCardTitle>
        <VCardText>
          <VTextField v-model="dialogValue" autofocus label="名前" density="compact" variant="outlined" hide-details @keydown.enter.prevent="saveNameDialog" />
        </VCardText>
        <VCardActions>
          <VSpacer />
          <VBtn variant="text" @click="dialogOpen = false">キャンセル</VBtn>
          <VBtn color="primary" variant="text" :disabled="!dialogValue.trim() || isBusy" @click="saveNameDialog">保存</VBtn>
        </VCardActions>
      </VCard>
    </VDialog>
  </aside>
</template>
