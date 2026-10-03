/** 空白の表示装飾を提供する。文字の置換や幅の変更は行わず、コピー内容も維持する。 */
import type { Extension } from '@codemirror/state'
import { Decoration, MatchDecorator, ViewPlugin, highlightWhitespace } from '@codemirror/view'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'

const fullWidthSpaceMatcher = new MatchDecorator({
  regexp: /\u3000/g,
  decoration: Decoration.mark({ class: 'cm-highlightFullWidthSpace' }),
})

const fullWidthSpaceHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  /** 表示範囲とその近傍だけを装飾し、長文でも文書全体を走査しない。 */
  constructor(view: EditorView) {
    this.decorations = fullWidthSpaceMatcher.createDeco(view)
  }

  /** 本文の編集と表示範囲の移動に合わせ、既存の装飾を差分更新する。 */
  update(update: ViewUpdate): void {
    this.decorations = fullWidthSpaceMatcher.updateDeco(update, this.decorations)
  }
}, { decorations: (value) => value.decorations })

/** CodeMirror標準の半角空白・タブ表示に、全角空白の表示だけを補う。 */
export function createWhitespaceExtensions(showWhitespace: boolean): Extension {
  return showWhitespace ? [highlightWhitespace(), fullWidthSpaceHighlighter] : []
}
