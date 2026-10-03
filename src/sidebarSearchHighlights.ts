/** Workerが照合した位置だけを強調し、正規表現を本文のUIスレッドで再実行しない。 */
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

export const sidebarMatches = StateEffect.define<{ from: number; to: number }[]>()
export const sidebarSearchHighlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (previous, transaction) => {
    let marks = transaction.docChanged ? Decoration.none : previous
    for (const effect of transaction.effects) {
      if (effect.is(sidebarMatches)) {
        marks = Decoration.set(effect.value.filter(range => range.to > range.from)
          .map(range => Decoration.mark({ class: 'cm-searchMatch' }).range(range.from, range.to)), true)
      }
    }
    return marks
  },
  provide: field => EditorView.decorations.from(field),
})
