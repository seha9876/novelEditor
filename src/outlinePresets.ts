/** アウトラインのプリセット操作と共有形式を、解析や画面から独立して扱う。 */
import { cloneOutline, cloneOutlineRules, createDefaultOutline, isOutlinePresetName, outlineRulesSignature, parseOutlineRules, STANDARD_OUTLINE_PRESET_ID, type OutlinePreferences, type OutlinePreset, type OutlineRule } from './outline'

export const standardOutlinePreset: OutlinePreset = { id: STANDARD_OUTLINE_PRESET_ID, name: '標準', rules: createDefaultOutline().rules }
export type OutlineAction =
  | { type: 'rules'; rules: OutlineRule[] }
  | { type: 'save'; id?: string; name?: string; rules?: OutlineRule[] }
  | { type: 'switch'; id: string; save?: { id?: string; name?: string; rules?: OutlineRule[] } }
  | { type: 'rename'; id: string; name: string }
  | { type: 'delete'; id: string }
  | { type: 'import'; preset: OutlinePreset }

/** 標準とユーザー登録の両方から、現在の基準プリセットを探す。 */
export function findOutlinePreset(value: OutlinePreferences, id = value.basePresetId): OutlinePreset | undefined {
  return [standardOutlinePreset, ...value.presets].find(preset => preset.id === id)
}

/** 順序・有効状態・判定内容のいずれかが違えば、保存済み設定からの変更とする。 */
export function isOutlineModified(value: OutlinePreferences): boolean {
  const preset = findOutlinePreset(value)
  return !preset || outlineRulesSignature(value) !== outlineRulesSignature(preset)
}

/** 上書き対象自身を除き、空白・制御文字・登録済みの同名を拒否する。 */
export function outlinePresetNameError(value: OutlinePreferences, name: string, exceptId?: string): string {
  if (!isOutlinePresetName(name)) return '名前は1～80文字で入力してください。制御文字は使用できません。'
  return [standardOutlinePreset, ...value.presets].some(preset => preset.id !== exceptId && preset.name === name.trim()) ? '同じ名前のプリセットがあります。' : ''
}

/** 未反映の検証済み下書きも含めて保存し、標準への上書きは認めない。 */
function saveOutlinePreset(value: OutlinePreferences, options: { id?: string; name?: string; rules?: OutlineRule[] }): void {
  if (options.rules) value.rules = parseOutlineRules(options.rules)
  if (options.id) {
    if (findOutlinePreset(value, options.id)) throw new Error('プリセットIDが重複しています。')
    const error = outlinePresetNameError(value, options.name ?? '')
    if (error) throw new Error(error)
    value.presets.push({ id: options.id, name: options.name!.trim(), rules: cloneOutlineRules(value) })
    value.basePresetId = options.id
  } else {
    const preset = value.presets.find(item => item.id === value.basePresetId)
    if (!preset) throw new Error('標準の設定は名前を付けて保存してください。')
    preset.rules = cloneOutlineRules(value)
  }
}

/** 一つの操作を参照独立な設定へ適用し、保存して切替を一つの履歴にまとめる。 */
export function applyOutlineAction(current: OutlinePreferences, action: OutlineAction): OutlinePreferences {
  const next = cloneOutline(current)
  switch (action.type) {
    case 'rules': next.rules = parseOutlineRules(action.rules); break
    case 'save': saveOutlinePreset(next, action); break
    case 'switch': {
      if (action.save) saveOutlinePreset(next, action.save)
      const target = findOutlinePreset(next, action.id)
      if (!target) throw new Error('プリセットが見つかりません。')
      next.rules = cloneOutlineRules(target); next.basePresetId = target.id
      break
    }
    case 'rename': {
      const preset = next.presets.find(item => item.id === action.id)
      if (!preset) throw new Error('標準の設定は名前を変更できません。')
      const error = outlinePresetNameError(next, action.name, action.id)
      if (error) throw new Error(error)
      preset.name = action.name.trim()
      break
    }
    case 'delete':
      if (!next.presets.some(item => item.id === action.id)) throw new Error('標準の設定は削除できません。')
      next.presets = next.presets.filter(item => item.id !== action.id)
      if (next.basePresetId === action.id) next.basePresetId = null
      break
    case 'import': {
      if (!action.preset.id || findOutlinePreset(next, action.preset.id) || !isOutlinePresetName(action.preset.name)) throw new Error('プリセットが不正です。')
      const rules = parseOutlineRules(action.preset.rules)
      let name = action.preset.name.trim(), suffix = 2
      while (outlinePresetNameError(next, name)) name = `${action.preset.name.trim().slice(0, 65)} (${suffix++})`
      next.presets.push({ id: action.preset.id, name, rules })
      break
    }
  }
  return next
}

/** 保存済みのルールだけを共有し、本文・例文・他の登録・プリセットIDは含めない。 */
export function exportOutlinePreset(preset: OutlinePreset): string {
  if (!isOutlinePresetName(preset.name)) throw new Error('プリセット名が不正です。')
  return JSON.stringify({ format: 'novel-editor-outline-preset', version: 1, name: preset.name.trim(), rules: parseOutlineRules(preset.rules) }, null, 2) + '\n'
}

/** 全件を検証してから新しい登録IDを付け、未対応形式を推測して取り込まない。 */
export function importOutlinePreset(text: string, id: string): OutlinePreset {
  let raw: unknown
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new Error('JSONファイルを読み取れません。') }
  if (!raw || typeof raw !== 'object') throw new Error('アウトラインプリセットではありません。')
  const value = raw as Record<string, unknown>
  if (value.format !== 'novel-editor-outline-preset') throw new Error('アウトラインプリセットの形式が違います。')
  if (value.version !== 1) throw new Error('このバージョンのアウトラインプリセットには対応していません。')
  if (!isOutlinePresetName(value.name) || !id) throw new Error('プリセット名またはIDが不正です。')
  return { id, name: value.name.trim(), rules: parseOutlineRules(value.rules) }
}
