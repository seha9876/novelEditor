/** CodeMirrorと同じカーソルで検索し、改行と位置の解釈を本文側に揃える。 */
import { Text } from '@codemirror/state'
import { SearchQuery } from '@codemirror/search'
import type { SearchConditions } from './searchSession'
export type TextMatch = { from: number; to: number; line: number; before: string; match: string; after: string }

/** 長い行や複数行一致でも短い抜粋にし、限定範囲をまたぐ一致を除外する。 */
export function findTextMatches(text: string, conditions: SearchConditions, limit: number, scope: { from: number; to: number } | null): { matches: TextMatch[]; limited: boolean } {
  const query = new SearchQuery({ ...conditions, literal: true })
  if (!conditions.search) return { matches: [], limited: false }
  if (!query.valid) throw new Error('正規表現が正しくありません。')
  const doc = Text.of(text.split('\n')), matches: TextMatch[] = []
  if (scope && scope.from === scope.to) return { matches, limited: false }
  const cursor = query.getCursor(doc)
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    const match = next.value
    if (scope && (match.from < scope.from || match.to > scope.to)) continue
    if (matches.length >= limit) return { matches, limited: true }
    const line = doc.lineAt(match.from)
    matches.push({ from: match.from, to: match.to, line: line.number,
      before: doc.sliceString(Math.max(line.from, match.from - 30), match.from), match: doc.sliceString(match.from, Math.min(match.to, match.from + 60)),
      after: doc.sliceString(match.to, Math.min(doc.lineAt(match.to).to, match.to + 30)) })
  }
  return { matches, limited: false }
}

/** 検索時と読込時のバイト列を比較し、更新された原稿の古い位置へ移動しない。 */
export async function fingerprintBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
