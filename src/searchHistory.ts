/** 検索履歴の永続化を直列化し、複数画面には同じ確定済み一覧を公開する。 */
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { SearchConditions } from './searchSession'

export type SearchHistoryEntry = { id: number; conditions: SearchConditions }
export type SearchHistoryState = { entries: SearchHistoryEntry[]; busy: boolean; error: string }
export type SearchHistoryAction = { type: 'remove'; id: number } | { type: 'clear' }

/** 初回読込前は空の一覧を表示する。検索入力そのものは履歴から初期化しない。 */
export function createSearchHistoryState(): SearchHistoryState {
  return { entries: [], busy: false, error: '' }
}

/** 改行やタブを一覧で識別できる表示へ変換する。保存値は変更しない。 */
export function previewSearchHistory(text: string): string {
  return text === '' ? '（空文字）' : text.replace(/\r/g, '␍').replace(/\n/g, '↵').replace(/\t/g, '⇥').replace(/ /g, '␠')
}

/** 書込順を固定し、削除以前に開始した非同期検索の遅着登録を無効にする。 */
export function useSearchHistory(onChange: () => void) {
  const state = ref(createSearchHistoryState())
  let queue = Promise.resolve(), pending = 0, deletionRevision = 0, disposed = false

  /** DBの確定結果だけを反映し、失敗しても後続操作と本文検索を継続できるようにする。 */
  function enqueue(command: string, args?: Record<string, unknown>): Promise<void> {
    if (disposed) return Promise.resolve()
    pending++; state.value.busy = true; onChange()
    queue = queue.then(async () => {
      try {
        const entries = await invoke<SearchHistoryEntry[]>(command, args)
        if (!disposed) { state.value.entries = entries; state.value.error = '' }
      } catch (error) {
        if (!disposed) state.value.error = `検索履歴を更新できません。検索・置換は引き続き使えます。${String(error)}`
      } finally {
        pending--
        if (!disposed) { state.value.busy = pending > 0; onChange() }
      }
    })
    return queue
  }

  /** 検証やファイル読込の前に条件を固定し、その間に削除があれば記録しない。 */
  function prepareRecord(conditions: SearchConditions): () => void {
    const captured = { ...conditions }, revision = deletionRevision
    return () => {
      if (disposed || revision !== deletionRevision || !captured.search) return
      void enqueue('search_history_record', { conditions: captured })
    }
  }

  /** 明示的に受理した検索操作の条件を、現在の書込キューへ追加する。 */
  function record(conditions: SearchConditions): void { prepareRecord(conditions)() }

  /** 読込も同じキューに入れ、古い一覧が後続の更新を上書きしないようにする。 */
  function load(): Promise<void> { return enqueue('search_history_list') }

  /** 削除要求を受けた時点で遅着登録を遮断し、既に受理済みの書込の後に削除する。 */
  function mutate(action: SearchHistoryAction): Promise<void> {
    deletionRevision++
    return action.type === 'clear' ? enqueue('search_history_clear') : enqueue('search_history_remove', { id: action.id })
  }

  /** 終了時は新規要求を止め、受理済み書込の完了を待つ。 */
  async function dispose(): Promise<void> { disposed = true; await queue }

  /** 窓の破棄前に受理済みの保存を待つ。終了が取り消された場合は引き続き利用できる。 */
  function flush(): Promise<void> { return queue }

  return { state, load, record, prepareRecord, mutate, dispose, flush }
}
