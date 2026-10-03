/** 最近開いたファイルの一覧・操作・遅着結果の破棄を管理する。 */
import { ref, type Ref } from 'vue'
import { ask } from '@tauri-apps/plugin-dialog'
import { clearRecentFiles, listRecentFiles, removeRecentFile, type RecentFile } from './recentFiles'

type RecentFilesOptions = {
  disabled: Readonly<Ref<boolean>>
  openFile: (file: RecentFile) => Promise<boolean>
}

/** 履歴画面を所有し、本文の変更と未保存確認は既存の文書セッションへ委ねる。 */
export function useRecentFilesController(options: RecentFilesOptions) {
  const isOpen = ref(false)
  const entries = ref<RecentFile[]>([])
  const selectedId = ref<number | null>(null)
  const pending = ref(false)
  const error = ref('')
  let disposed = false

  /** 開くたびに永続化済み履歴を読み込み、削除済み項目や古い順序を持ち越さない。 */
  async function open(): Promise<void> {
    if (disposed || pending.value || options.disabled.value || isOpen.value) return
    isOpen.value = true
    pending.value = true
    error.value = ''
    entries.value = []
    selectedId.value = null
    try {
      const loaded = await listRecentFiles()
      if (disposed) return
      entries.value = loaded
      selectedId.value = loaded[0]?.id ?? null
    } catch (failure) {
      if (!disposed) error.value = String(failure)
    } finally {
      if (!disposed) pending.value = false
    }
  }

  /** 操作中以外は閉じられる。未完了の読込・削除中の二重操作を防ぐ。 */
  function close(): void {
    if (!pending.value) isOpen.value = false
  }

  /** 上下キーで候補を移動し、端では止める。 */
  function moveSelection(direction: -1 | 1): void {
    if (disposed || pending.value || options.disabled.value || !entries.value.length) return
    const index = entries.value.findIndex((entry) => entry.id === selectedId.value)
    selectedId.value = entries.value[Math.max(0, Math.min(entries.value.length - 1, index + direction))].id
  }

  /** 一覧にあるファイルだけ開き、成功時のみ閉じる。取消・読込失敗では履歴を保つ。 */
  async function openSelected(id: number): Promise<void> {
    if (disposed || !isOpen.value || pending.value || options.disabled.value) return
    const entry = entries.value.find((item) => item.id === id)
    if (!entry) return
    selectedId.value = id
    error.value = ''
    pending.value = true
    try {
      const opened = await options.openFile(entry)
      if (!disposed && opened) isOpen.value = false
    } catch (failure) {
      if (!disposed) error.value = String(failure)
    } finally {
      if (!disposed) pending.value = false
    }
  }

  /** 履歴だけを削除し、全消去の場合は先に確認する。失敗時は画面の一覧を変更しない。 */
  async function remove(id: number | null): Promise<void> {
    if (disposed || !isOpen.value || pending.value || options.disabled.value) return
    if (id !== null && !entries.value.some((entry) => entry.id === id)) return
    pending.value = true
    error.value = ''
    try {
      if (id === null) {
        const confirmed = await ask('ファイル履歴をすべて消去しますか？ 実ファイルは削除されません。', {
          title: '最近開いたファイル', kind: 'warning', okLabel: '履歴を消去', cancelLabel: 'キャンセル',
        })
        if (disposed || !confirmed) return
        await clearRecentFiles()
      } else {
        await removeRecentFile(id)
      }
      if (disposed) return
      const index = entries.value.findIndex((entry) => entry.id === id)
      entries.value = id === null ? [] : entries.value.filter((entry) => entry.id !== id)
      if (!entries.value.some((entry) => entry.id === selectedId.value)) {
        selectedId.value = entries.value[Math.min(Math.max(0, index), entries.value.length - 1)]?.id ?? null
      }
    } catch (failure) {
      if (!disposed) error.value = String(failure)
    } finally {
      if (!disposed) pending.value = false
    }
  }

  /** 終了後の通信結果で一覧やフォーカスを更新しないよう操作を無効化する。 */
  function dispose(): void {
    disposed = true
    isOpen.value = false
    pending.value = false
  }

  return { isOpen, entries, selectedId, pending, error, open, close, moveSelection, openSelected, remove, dispose }
}
