/** 本文の編集履歴をメニューと共有する。履歴そのものはCodeMirrorだけが管理する。 */
import { undo, redo, undoDepth, redoDepth } from '@codemirror/commands'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export type EditorHistoryAction = 'undo' | 'redo'
export type EditorHistoryState = { canUndo: boolean; canRedo: boolean }

/** 読み取り専用状態を含め、現在の本文で実行できる履歴操作を返す。 */
export function getEditorHistoryState(state: EditorState): EditorHistoryState {
  return { canUndo: !state.readOnly && undoDepth(state) > 0, canRedo: !state.readOnly && redoDepth(state) > 0 }
}

/** 実行時の状態を再確認して既存の履歴を操作し、成功した場合だけ本文へ戻す。IME変換中は触らない。 */
export function runEditorHistoryAction(view: EditorView, action: EditorHistoryAction): boolean {
  if (view.composing || view.state.readOnly) return false
  const changed = (action === 'undo' ? undo : redo)(view)
  if (changed) view.focus()
  return changed
}
