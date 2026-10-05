/** 原稿の書式を変更せず、行ごとのルールで見出しを抽出する。 */
export type OutlineRule = {
  id: string; name: string; enabled: boolean; level: number
  kind: 'standard' | 'affix' | 'numbered' | 'regexp'
  pattern: string; prefix: string; suffix: string
}
export type OutlineRuleSet = { rules: OutlineRule[] }
export type OutlinePreset = OutlineRuleSet & { id: string; name: string }
export type OutlinePreferences = OutlineRuleSet & { basePresetId: string | null; presets: OutlinePreset[] }
export const STANDARD_OUTLINE_PRESET_ID = 'builtin-standard'
export const outlineExample = '第一章 再会\n本文です。\n第一節 翌朝'
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
  ].map(([id, name, level]) => ({ id: String(id), name: String(name), kind: 'standard', enabled: true, level: Number(level), pattern: String(id), prefix: '', suffix: '' })), basePresetId: STANDARD_OUTLINE_PRESET_ID, presets: [] }
}

/** 文字列条件を正規表現の命令として扱わず、そのまま一致させる。 */
function escapePattern(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** 入力途中や不正なルールを保存せず、修正に必要な理由を返す。 */
export function outlineRuleError(rule: OutlineRule): string {
  if (!rule.id || !rule.name.trim()) return 'ルールの名前を入力してください。'
  if (!Number.isInteger(rule.level) || rule.level < 1 || rule.level > 6) return 'レベルは1～6です。'
  if (rule.kind === 'standard') return Object.prototype.hasOwnProperty.call(standardPatterns, rule.pattern) ? '' : '標準ルールが不正です。'
  if (rule.kind === 'affix') return rule.prefix || rule.suffix ? '' : '行頭または行末の文字を入力してください。'
  if (rule.kind === 'numbered') return rule.pattern.split('{番号}').length === 2 ? '' : '形式に {番号} を1つ入れてください。'
  if (rule.kind !== 'regexp' || !rule.pattern.trim()) return '正規表現を入力してください。'
  try { new RegExp(rule.pattern, 'u'); return '' } catch { return '正規表現が正しくありません。' }
}

/** 共有ファイルや通信のルールを検証し、保存対象のフィールドだけ取り出す。 */
function readOutlineRule(raw: unknown): OutlineRule | null {
  if (!raw || typeof raw !== 'object') return null
  const rule = raw as OutlineRule
  if (typeof rule.id !== 'string' || typeof rule.name !== 'string' || typeof rule.pattern !== 'string'
    || typeof rule.prefix !== 'string' || typeof rule.suffix !== 'string' || typeof rule.enabled !== 'boolean'
    || outlineRuleError(rule)) return null
  return { id: rule.id, name: rule.name, kind: rule.kind, enabled: rule.enabled, level: rule.level, pattern: rule.pattern, prefix: rule.prefix, suffix: rule.suffix }
}

/** 不正・重複したルールを部分的に取り込まず、空配列は有効な設定として扱う。 */
export function parseOutlineRules(value: unknown): OutlineRule[] {
  if (!Array.isArray(value)) throw new Error('見出しルールの一覧が不正です。')
  const seen = new Set<string>()
  return value.map(raw => {
    const rule = readOutlineRule(raw)
    if (!rule || seen.has(rule.id)) throw new Error('見出しルールに不正な入力または重複したIDがあります。')
    seen.add(rule.id)
    return rule
  })
}

/** プリセット名は配色と同じ長さ・制御文字の制約にする。 */
export function isOutlinePresetName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 80 && !/\p{Cc}/u.test(value)
}

/** 旧設定を移行する。保存された空配列や削除済みの標準ルールは補完しない。 */
export function normalizeOutline(value: unknown): OutlinePreferences {
  if (!value || typeof value !== 'object' || !('rules' in value) || !Array.isArray(value.rules)) return createDefaultOutline()
  const raw = value as Partial<OutlinePreferences>
  const seen = new Set<string>(), rules: OutlineRule[] = []
  for (const item of value.rules) {
    const rule = readOutlineRule(item)
    if (rule && !seen.has(rule.id)) { seen.add(rule.id); rules.push(rule) }
  }
  const ids = new Set([STANDARD_OUTLINE_PRESET_ID]), names = new Set(['標準'])
  const presets: OutlinePreset[] = []
  for (const preset of Array.isArray(raw.presets) ? raw.presets : []) {
    if (!preset || typeof preset.id !== 'string' || !preset.id || ids.has(preset.id)
      || !isOutlinePresetName(preset.name) || names.has(preset.name.trim())) continue
    try {
      const presetRules = parseOutlineRules(preset.rules)
      presets.push({ id: preset.id, name: preset.name.trim(), rules: presetRules })
      ids.add(preset.id); names.add(preset.name.trim())
    } catch { /* 壊れた登録を補修して、別の判定ルールとして保存しない。 */ }
  }
  const basePresetId = 'basePresetId' in raw
    ? typeof raw.basePresetId === 'string' && ids.has(raw.basePresetId) ? raw.basePresetId : null
    : outlineRulesSignature({ rules }) === outlineRulesSignature(createDefaultOutline()) ? STANDARD_OUTLINE_PRESET_ID : null
  return { rules, basePresetId, presets }
}

/** Workerには現在のルールだけを複製し、登録済みプリセットを送らない。 */
export function cloneOutlineRules(value: OutlineRuleSet): OutlineRule[] { return value.rules.map(rule => ({ ...rule })) }

/** オブジェクトの欄の作成順に左右されず、ルールの優先順位と内容を比較する。 */
export function outlineRulesSignature(value: OutlineRuleSet): string {
  return JSON.stringify(value.rules.map(rule => [rule.id, rule.name, rule.enabled, rule.level, rule.kind, rule.pattern, rule.prefix, rule.suffix]))
}

/** 保存・Undoでは現在のルールと各プリセットの配列を独立して複製する。 */
export function cloneOutline(value: OutlinePreferences): OutlinePreferences {
  return { rules: cloneOutlineRules(value), basePresetId: value.basePresetId ?? null, presets: (value.presets ?? []).map(preset => ({ id: preset.id, name: preset.name, rules: cloneOutlineRules(preset) })) }
}

/** 一行に複数ルールが一致した場合は上位だけを採用し、実在する上位見出しへ接続する。 */
export function extractOutline(text: string, preferences: OutlineRuleSet): OutlineHeading[] {
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
