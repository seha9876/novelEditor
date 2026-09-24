<script setup lang="ts">
// 保存先を開けないときに、移行の再試行・取消・既存データの再指定を行う。
import { computed, ref } from 'vue'
import { open } from '@tauri-apps/plugin-dialog'
import {
  cancelStorageChange,
  relinkExistingStorage,
  retryStorageStartup,
  type StorageStatus,
} from './storageLocation'

const props = defineProps<{
  initialStatus: StorageStatus | null
  initialError?: string
}>()

const status = ref(props.initialStatus)
const errorMessage = ref(props.initialError ?? props.initialStatus?.blockedReason ?? '保存先を確認できません。')
const busy = ref(false)
const pendingDirectory = computed(() => status.value?.pendingDirectory ?? null)

/** 起動時の保存先確認を再試行し、成功したら通常の初期化をやり直す。 */
async function retryStartup(): Promise<void> {
  busy.value = true
  errorMessage.value = ''
  try {
    const nextStatus = await retryStorageStartup()
    status.value = nextStatus
    if (nextStatus.blockedReason) {
      errorMessage.value = nextStatus.blockedReason
      return
    }
    window.location.reload()
  } catch (error) {
    errorMessage.value = String(error)
  } finally {
    busy.value = false
  }
}

/** 予約した移行を取り消し、現在の保存先を使う起動処理を試す。 */
async function cancelPendingMigration(): Promise<void> {
  busy.value = true
  errorMessage.value = ''
  try {
    status.value = await cancelStorageChange()
    const nextStatus = await retryStorageStartup()
    status.value = nextStatus
    if (nextStatus.blockedReason) {
      errorMessage.value = nextStatus.blockedReason
      return
    }
    window.location.reload()
  } catch (error) {
    errorMessage.value = String(error)
  } finally {
    busy.value = false
  }
}

/** ユーザーが選んだ既存データフォルダーへポインターを付け替える。 */
async function chooseExistingDataDirectory(): Promise<void> {
  errorMessage.value = ''
  try {
    const dataDirectory = await open({
      directory: true,
      multiple: false,
      defaultPath: status.value?.pendingDirectory ?? status.value?.activeDirectory ?? status.value?.defaultDirectory,
    })
    if (typeof dataDirectory !== 'string') return
    busy.value = true
    const nextStatus = await relinkExistingStorage(dataDirectory)
    status.value = nextStatus
    if (nextStatus.blockedReason) {
      errorMessage.value = nextStatus.blockedReason
      return
    }
    window.location.reload()
  } catch (error) {
    errorMessage.value = String(error)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <VApp>
    <VMain class="storage-startup-main">
      <VContainer class="storage-startup-container">
        <VCard max-width="760" class="mx-auto" variant="outlined">
          <VCardTitle>アプリデータの保存先を利用できません</VCardTitle>
          <VCardText>
            <p>保存先を確認できないため、設定・プロジェクトツリー・復元データを読み込んでいません。別の空のデータで起動することはありません。</p>
            <VAlert v-if="errorMessage" type="error" variant="tonal" class="storage-startup-message" role="alert">
              {{ errorMessage }}
            </VAlert>
            <VAlert v-if="status" type="info" variant="tonal" class="storage-startup-message">
              <div><strong>現在の保存先</strong></div>
              <div class="storage-location-path">{{ status.activeDirectory }}</div>
              <template v-if="pendingDirectory">
                <div class="storage-location-label"><strong>予約された保存先</strong></div>
                <div class="storage-location-path">{{ pendingDirectory }}</div>
              </template>
            </VAlert>
            <p class="storage-startup-description">
              移行を再試行するか、予約を取り消してください。保存先を移動・変更した場合は、既存の <code>preferences.json</code>、<code>project-tree.sqlite3</code>、<code>recovery.json</code> が入っているデータフォルダーを選択してください。
            </p>
            <div class="storage-startup-actions">
              <VBtn color="primary" prepend-icon="mdi-refresh" :disabled="busy" @click="retryStartup">
                保存先を再試行
              </VBtn>
              <VBtn v-if="pendingDirectory" variant="text" :disabled="busy" @click="cancelPendingMigration">
                変更予約を取り消す
              </VBtn>
              <VBtn variant="text" prepend-icon="mdi-folder-search-outline" :disabled="busy" @click="chooseExistingDataDirectory">
                既存データフォルダーを再指定
              </VBtn>
            </div>
          </VCardText>
        </VCard>
      </VContainer>
    </VMain>
  </VApp>
</template>
