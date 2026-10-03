/** 原稿の書式を変更せず、行ごとのルールで見出しを抽出する。 */
export type OutlineRule = {
  id: string; name: string; enabled: boolean; level: number
  kind: 'standard' | 'affix' | 'numbered' | 'regexp'
  pattern: string; prefix: string; suffix: string
}
export type OutlinePreferences = { rules: OutlineRule[] }
export type OutlineHeading = { from: number; line: number; text: string; level: number; parent: number | null; ruleId: string }
const numbers = '[0-9０-９〇零一二三四五六七八九十百千万億兆壱弐参拾]+'
const title = '(?:[\\s\u3000]+.+|[：:].+)?$'
const standardPatterns: Record<string, string> = {
  part: `^第[\\s\u3000]*${numbers}[\\s\u3000]*部${title}`,
  chapter: `^第[\\s\u3000]*${numbers}[\\s\u3000]*(?:章|話)${title}`,
  section: `^第[\\s\u3000]*${numbers}[\\s\u3000]*節${title}`,
  special: `^(?:プロローグ|エピローグ|序章|終章)${title}`,
}

/** 明確な章・節だけを初期判定し、本文中の番号列挙は見出しにしない。 */
export function createDefaultOutline(): OutlinePreferences {
  return { rules: [
    ['part', '部', 1], ['chapter', '章・話', 2], ['section', '節', 3], ['special', '序章・終章など', 2],
  ].map(([id, name, level]) => ({ id: String(id), name: String(name), kind: 'standard', enabled: true, level: Number(level), pattern: String(id), prefix: '', suffix: '' })) }
}

/** 文字列条件を正規表現の命令として扱わず、そのまま一致させる。 */
function escapePattern(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** 入力途中や不正なルールを保存せず、修正に必要な理由を返す。 */
export function outlineRuleError(rule: OutlineRule): string {
  if (!rule.id || !rule.name.trim()) return 'ルールの名前を入力してください。'
  if (!Number.isInteger(rule.level) || rule.level < 1 || rule.level > 6) return 'レベルは1～6です。'
  if (rule.kind === 'standard') return standardPatterns[rule.pattern] ? '' : '標準ルールが不正です。'
  if (rule.kind === 'affix') return rule.prefix || rule.suffix ? '' : '行頭または行末の文字を入力してください。'
  if (rule.kind === 'numbered') return rule.pattern.split('{番号}').length === 2 ? '' : '形式に {番号} を1つ入れてください。'
  if (rule.kind !== 'regexp' || !rule.pattern.trim()) return '正規表現を入力してください。'
  try { new RegExp(rule.pattern, 'u'); return '' } catch { return '正規表現が正しくありません。' }
}

/** 旧設定に標準を補完し、保存された独自ルールは検証済みの値だけ取り込む。 */
export function normalizeOutline(value: unknown): OutlinePreferences {
  if (!value || typeof value !== 'object' || !('rules' in value) || !Array.isArray(value.rules)) return createDefaultOutline()
  const seen = new Set<string>()
  const rules: OutlineRule[] = []
  for (const raw of value.rules) {
    if (!raw || typeof raw !== 'object') continue
    const rule = { ...raw } as OutlineRule
    if (typeof rule.id !== 'string' || typeof rule.name !== 'string' || typeof rule.pattern !== 'string'
      || typeof rule.prefix !== 'string' || typeof rule.suffix !== 'string' || typeof rule.enabled !== 'boolean'
      || outlineRuleError(rule) || seen.has(rule.id)) continue
    seen.add(rule.id); rules.push({ id: rule.id, name: rule.name, kind: rule.kind, enabled: rule.enabled, level: rule.level, pattern: rule.pattern, prefix: rule.prefix, suffix: rule.suffix })
  }
  return { rules }
}

/** 保存・Undoでルール配列を共有しないよう複製する。 */
export function cloneOutline(value: OutlinePreferences): OutlinePreferences { return { rules: value.rules.map(rule => ({ ...rule })) } }

/** 一行に複数ルールが一致した場合は上位だけを採用し、実在する上位見出しへ接続する。 */
export function extractOutline(text: string, preferences: OutlinePreferences): OutlineHeading[] {
  const rules = preferences.rules.filter(rule => rule.enabled).map(rule => {
    const error = outlineRuleError(rule)
    if (error) throw new Error(`${rule.name}: ${error}`)
    let pattern = rule.pattern
    if (rule.kind === 'standard') pattern = standardPatterns[rule.pattern]!
    if (rule.kind === 'numbered') pattern = '^' + rule.pattern.split('{番号}').map(escapePattern).join(numbers) + title
    return { rule, expression: rule.kind === 'affix' ? null : new RegExp(pattern, 'u') }
  })
  const headings: OutlineHeading[] = [], stack: number[] = []
  let from = 0
  for (const [index, original] of text.split('\n').entries()) {
    const line = original.trim()
    const match = line && rules.find(({ rule, expression }) => expression ? expression.test(line) : line.startsWith(rule.prefix) && line.endsWith(rule.suffix))
    if (match) {
      while (stack.length && headings[stack[stack.length - 1]!]!.level >= match.rule.level) stack.pop()
      headings.push({ from, line: index + 1, text: line, level: match.rule.level, parent: stack[stack.length - 1] ?? null, ruleId: match.rule.id })
      stack.push(headings.length - 1)
    }
    from += original.length + 1
  }
  return headings
}
