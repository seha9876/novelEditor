/** 表示やエディターに依存しない文字数。改行は両方から除く。 */
export type TextCounts = { characters: number; withoutWhitespace: number }

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' })
const lineBreak = /^(?:\r\n|[\r\n\u0085\u2028\u2029])$/u
const whitespace = /^\p{White_Space}+$/u

/** 見た目の文字に近い書記素単位で数える。本文の正規化や書き換えは行わない。 */
export function countText(text: string): TextCounts {
  let characters = 0
  let withoutWhitespace = 0
  for (const { segment } of segmenter.segment(text)) {
    if (lineBreak.test(segment)) continue
    characters += 1
    if (!whitespace.test(segment)) withoutWhitespace += 1
  }
  return { characters, withoutWhitespace }
}

/** 行内のUTF-16位置を1始まりの書記素列へ変換する。書記素内部はその文字の列とする。 */
export function countColumn(line: string, offset: number): number {
  let column = 1
  for (const { segment, index } of segmenter.segment(line)) {
    if (index + segment.length > offset) break
    column += 1
  }
  return column
}
