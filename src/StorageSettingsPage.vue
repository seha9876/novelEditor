<script setup lang="ts">
// 現在の保存先と次回起動時に適用する保存先を表示し、移行を予約する。
import { onMounted, ref } from 'vue'
import { open } from '@tauri-apps/plugin-dialog'
import SettingExpansionSection from './SettingExpansionSection.vue'
import type { SettingsSectionDefinition, SettingsSectionId } from './settingsDefinitions'
import {
  cancelStorageChange,
  abandonStorageCleanup,
  getStorageStatus,
  scheduleDefaultStorage,
  scheduleExistingStorage,
  scheduleStorageChange,
  type StorageStatus,
} from './storageLocation'

defineProps<{
  headingLevel: number
  sections: readonly SettingsSectionDefinition[]
  expandedSectionIds: readonly SettingsSectionId[]
}>()

const emit = defineEmits<{
  toggleSection: [sectionId: SettingsSectionId, expanded: boolean]
}>()

const status = ref<StorageStatus | null>(null)
const busy = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const selectedExistingDirectory = ref<string | null>(null)
const existingDirectoryDialog = ref(false)
const abandonCleanupDialog = ref(false)

/** 最新の保存先状態をRustから読み込む。 */
async function refreshStorageStatus(): Promise<void> {
  status.value = await getStorageStatus()
}

/** 親フォルダを選び、その配下への保存先移行を次回起動用に予約する。 */
async function chooseStorageDirectory(): Promise<void> {
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const parentDirectory = await open({
      directory: true,
      multiple: false,
      defaultPath: status.value?.activeDirectory ?? status.value?.defaultDirectory,
    })
    if (typeof parentDirectory !== 'string') return
    busy.value = true
    status.value = await scheduleStorageChange(parentDirectory)
    successMessage.value = '新しい保存先は次回起動時に適用されます。'
  } catch (error) {
    errorMessage.value = `保存先を変更できませんでした。${String(error)}`
  } finally {
    busy.value = false
  }
}

/** 次回起動に予約した保存先を取り消し、現在の保存先を維持する。 */
async function cancelScheduledChange(): Promise<void> {
  errorMessage.value = ''
  successMessage.value = ''
  busy.value = true
  try {
    status.value = await cancelStorageChange()
    successMessage.value = '保存先の変更予約を取り消しました。'
  } catch (error) {
    errorMessage.value = `変更予約を取り消せませんでした。${String(error)}`
  } finally {
    busy.value = false
  }
}

/** 既定の保存先を次回起動用に予約する。 */
async function restoreDefaultStorage(): Promise<void> {
  errorMessage.value = ''
  successMessage.value = ''
  busy.value = true
  try {
    status.value = await scheduleDefaultStorage()
    successMessage.value = '現在のデータを既定の保存先へ移動する予約をしました。次回起動時に適用されます。'
  } catch (error) {
    errorMessage.value = `既定の保存先への変更を予約できませんでした。${String(error)}`
  } finally {
    busy.value = false
  }
}

/** 使用する既存データフォルダーを選択し、内容を確認する画面を開く。 */
async function chooseExistingDataDirectory(): Promise<void> {
  errorMessage.value = ''
  try {
    const dataDirectory = await open({
      directory: true,
      multiple: false,
      defaultPath: status.value?.activeDirectory ?? status.value?.defaultDirectory,
    })
    if (typeof dataDirectory === 'string') {
      selectedExistingDirectory.value = dataDirectory
      existingDirectoryDialog.value = true
    }
  } catch (error) {
    errorMessage.value = `フォルダーを選択できませんでした。${String(error)}`
  }
}

/** 選択先の既存データを次回起動から使うよう予約する。 */
async function confirmExistingDataDirectory(): Promise<void> {
  const dataDirectory = selectedExistingDirectory.value
  if (!dataDirectory) return
  errorMessage.value = ''
  successMessage.value = ''
  busy.value = true
  try {
    status.value = await scheduleExistingStorage(dataDirectory)
    existingDirectoryDialog.value = false
    successMessage.value = '選択した既存データフォルダーは次回起動時に使われます。'
  } catch (error) {
    errorMessage.value = `既存データフォルダーを予約できませんでした。${String(error)}`
    existingDirectoryDialog.value = false
  } finally {
    busy.value = false
  }
}

/** 旧ファイルは残し、Rustに保存した片付け予約だけを明示確認後に解除する。 */
async function confirmAbandonCleanup(): Promise<void> {
  errorMessage.value = ''
  successMessage.value = ''
  busy.value = true
  try {
    status.value = await abandonStorageCleanup()
    abandonCleanupDialog.value = false
    successMessage.value = '旧保存先のファイルは残したまま、片付けの自動再試行を停止しました。'
  } catch (error) {
    errorMessage.value = `片付け予約を解除できませんでした。${String(error)}`
    abandonCleanupDialog.value = false
  } finally {
    busy.value = false
  }
}

// 起動状態を読み込んでから保存先の操作を有効にする。
onMounted(async () => {
  try {
    await refreshStorageStatus()
  } catch (error) {
    errorMessage.value = `保存先を読み込めませんでした。${String(error)}`
  }
})
</script>

<template>
  <SettingExpansionSection
    v-for="section in sections"
    :key="section.id"
    :section="section"
    :heading-level="headingLevel"
    :expanded="expandedSectionIds.includes(section.id)"
    @update-expanded="emit('toggleSection', section.id, $event)"
  >
    <template #status>
      <VChip v-if="status?.cleanupPending" color="warning" size="x-small" variant="tonal">片付け未完了</VChip>
      <VChip v-else-if="status?.pendingDirectory" color="info" size="x-small" variant="tonal">変更予約あり</VChip>
    </template>
    <template v-if="section.id === 'application.storage.location'">
      <p class="setting-subsection-description">
        設定、プロジェクト情報、未保存本文の復元データを保存する場所です。本文のTXTファイルは移動しません。
      </p>
      <VSheet v-if="status" color="surface-light" rounded="lg" border class="storage-location-current">
        <div class="storage-location-current-label">現在使用中の保存先</div>
        <div class="storage-location-path storage-location-current-path">{{ status.activeDirectory }}</div>
        <VDivider class="storage-location-divider" />
        <div class="storage-location-default-label">既定の保存先</div>
        <div class="storage-location-path">{{ status.defaultDirectory }}</div>
        <p class="storage-location-default-description">Windowsがこのアプリ用に用意する保存場所です。</p>
      </VSheet>
      <VAlert v-if="status?.pendingDirectory" type="info" variant="tonal" class="storage-location-message">
        <div class="storage-location-pending-label">再起動後に使用する保存先</div>
        <div class="storage-location-path storage-location-pending-path">{{ status.pendingDirectory }}</div>
        <p class="storage-location-pending-description">この保存先はまだ使用されていません。現在は上の保存先を使用しています。</p>
        <VBtn variant="text" prepend-icon="mdi-close-circle-outline" :disabled="busy" @click="cancelScheduledChange">
          変更予約を取り消す
        </VBtn>
      </VAlert>
      <VAlert v-if="status?.cleanupPending" type="warning" variant="tonal" class="storage-location-message">
        <p>旧保存先の確認が終わるまで、別の保存先変更は予約できません。</p>
        <VBtn variant="text" color="warning" prepend-icon="mdi-broom" :disabled="busy" @click="abandonCleanupDialog = true">
          片付けの自動再試行をやめる
        </VBtn>
      </VAlert>
      <VAlert v-if="errorMessage" type="error" variant="tonal" class="storage-location-message" role="alert">
        {{ errorMessage }}
      </VAlert>
      <VAlert v-if="successMessage" type="success" variant="tonal" class="storage-location-message" role="status">
        {{ successMessage }}
      </VAlert>
      <div class="setting-actions">
        <VBtn color="primary" prepend-icon="mdi-folder-cog-outline" :disabled="busy || !status || status.cleanupPending" @click="chooseStorageDirectory">
          保存先を変更
        </VBtn>
        <VMenu location="bottom start" :disabled="busy || !status || status.cleanupPending">
          <template #activator="{ props: menuProps }">
            <VBtn v-bind="menuProps" variant="text" append-icon="mdi-menu-down" :disabled="busy || !status || status.cleanupPending">
              その他の操作
            </VBtn>
          </template>
          <VList density="compact" min-width="280" role="menu" aria-label="保存先のその他の操作">
            <VListItem role="menuitem" title="既存のデータフォルダーを使用" prepend-icon="mdi-folder-open-outline" @click="chooseExistingDataDirectory" />
            <VListItem
              v-if="status && status.activeDirectory !== status.defaultDirectory && status.pendingDirectory !== status.defaultDirectory"
              role="menuitem"
              title="現在のデータを既定の保存先へ移動"
              prepend-icon="mdi-folder-home-outline"
              @click="restoreDefaultStorage"
            />
          </VList>
        </VMenu>
      </div>
      <p class="setting-help storage-location-help">
        「保存先を変更」では選択したフォルダー内に <code>novelEditor-data</code> を作成し、現在のデータを次回起動時に移動します。
      </p>
      <p class="setting-help storage-location-help">
        保存先操作は設定のUndo／Redoと「すべて初期値に戻す」の対象外です。
      </p>
    </template>
  </SettingExpansionSection>
  <VDialog v-model="existingDirectoryDialog" max-width="520">
    <VCard title="選択したデータフォルダーを使用しますか？">
      <VCardText>
        <p class="storage-location-path">{{ selectedExistingDirectory }}</p>
        <p class="setting-subsection-description">
          次回起動から選択先の設定・プロジェクトツリー・復元データを使います。現在のデータとは統合されず、現在の保存先にあるファイルも変更・削除しません。
        </p>
      </VCardText>
      <VCardActions>
        <VSpacer />
        <VBtn variant="text" :disabled="busy" @click="existingDirectoryDialog = false">戻る</VBtn>
        <VBtn color="primary" :disabled="busy" @click="confirmExistingDataDirectory">次回起動に予約</VBtn>
      </VCardActions>
    </VCard>
  </VDialog>
  <VDialog v-model="abandonCleanupDialog" max-width="540">
    <VCard title="片付けの自動再試行をやめますか？">
      <VCardText>
        旧保存先の <code>preferences.json</code>、<code>project-tree.sqlite3</code>、<code>recovery.json</code> はその場所に残り、削除されません。この操作では自動片付けの予約だけを解除します。解除後は別の保存先変更を予約できます。
      </VCardText>
      <VCardActions>
        <VSpacer />
        <VBtn variant="text" :disabled="busy" @click="abandonCleanupDialog = false">戻る</VBtn>
        <VBtn color="warning" :disabled="busy" @click="confirmAbandonCleanup">自動再試行をやめる</VBtn>
      </VCardActions>
    </VCard>
  </VDialog>
</template>
