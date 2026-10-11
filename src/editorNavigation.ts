import { EditorSelection, type EditorState, type Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { countColumn, offsetAtColumn } from './textStatistics'

/** 折り返しに依存しない、1始まりの論理行と書記素列。 */
export type EditorPosition = { line: number; column: number }

/** 複数選択でも主カーソルだけを記録し、本文や選択範囲自体は保存しない。 */
export function getEditorPosition(state: EditorState): EditorPosition {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  return { line: line.number, column: countColumn(line.text, head - line.from) }
}

/** 保存位置を現在の本文へ補正する。不正な記録は先頭とし、書記素の途中へは戻さない。 */
export function resolveEditorPosition(doc: Text, position?: EditorPosition | null): number {
  if (!position || !Number.isSafeInteger(position.line) || position.line < 1
    || !Number.isSafeInteger(position.column) || position.column < 1) return 0
  const line = doc.line(Math.min(position.line, doc.lines))
  return line.from + offsetAtColumn(line.text, position.column)
}

/** 行番号は1始まりの整数だけを受け付け、範囲外や省略記法による意図しない移動を防ぐ。 */
export function parseLineNumber(value: string, lineCount: number): number | null {
  const trimmed = value.trim()
  if (!/^[0-9]+$/.test(trimmed)) return null
  const line = Number(trimmed)
  return Number.isSafeInteger(line) && line >= 1 && line <= lineCount ? line : null
}

/** 指定した論理行の先頭へ移動する。本文とUndo履歴を保ち、文書ロック時は操作しない。 */
export function goToEditorLine(view: EditorView, line: number): boolean {
  if (view.state.readOnly || !Number.isSafeInteger(line) || line < 1 || line > view.state.doc.lines) return false
  const position = view.state.doc.line(line).from
  view.dispatch({
    selection: EditorSelection.cursor(position),
    effects: EditorView.scrollIntoView(position, { y: 'center' }),
    userEvent: 'select',
  })
  return true
}
