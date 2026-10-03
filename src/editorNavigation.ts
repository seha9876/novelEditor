import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

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
