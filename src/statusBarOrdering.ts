/** ステータスバーの保存順と設定画面の表示順を相互変換する。 */
import type { StatusBarItemId } from './appPreferenceSchema'

/** 保存配列（実表示の左端から右端）を設定画面の上から下へ変換する。 */
export function getStatusBarSettingsItems(items: readonly StatusBarItemId[]): StatusBarItemId[] {
  return [...items].reverse()
}

/** 設定画面の上から下の配列を、実表示の左端から右端へ戻す。 */
export function getStatusBarStoredItems(items: readonly StatusBarItemId[]): StatusBarItemId[] {
  return [...items].reverse()
}

/** 設定画面の挿入位置を配列の範囲内へ収める。 */
function clampInsertionIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length))
}

/** 設定画面の項目を指定位置へ追加し、保存配列へ戻す。 */
export function insertStatusBarItemAtSettingsIndex(
  items: readonly StatusBarItemId[],
  itemId: StatusBarItemId,
  insertionIndex: number,
): StatusBarItemId[] {
  const settingsItems = getStatusBarSettingsItems(items)
  settingsItems.splice(clampInsertionIndex(insertionIndex, settingsItems.length), 0, itemId)
  return getStatusBarStoredItems(settingsItems)
}

/** 設定画面で指定した項目を削除し、保存配列へ戻す。 */
export function removeStatusBarItemAtSettingsIndex(
  items: readonly StatusBarItemId[],
  settingsIndex: number,
): StatusBarItemId[] {
  if (!Number.isInteger(settingsIndex) || settingsIndex < 0 || settingsIndex >= items.length) return [...items]
  const settingsItems = getStatusBarSettingsItems(items)
  settingsItems.splice(settingsIndex, 1)
  return getStatusBarStoredItems(settingsItems)
}

/** 設定画面上の項目を別の表示位置へ移動し、保存配列へ戻す。 */
export function reorderStatusBarItemsAtSettingsIndex(
  items: readonly StatusBarItemId[],
  sourceIndex: number,
  destinationIndex: number,
): StatusBarItemId[] {
  if (
    !Number.isInteger(sourceIndex)
    || !Number.isInteger(destinationIndex)
    || sourceIndex < 0
    || destinationIndex < 0
    || sourceIndex >= items.length
    || destinationIndex >= items.length
  ) return [...items]
  if (sourceIndex === destinationIndex) return [...items]

  const settingsItems = getStatusBarSettingsItems(items)
  const [item] = settingsItems.splice(sourceIndex, 1)
  settingsItems.splice(destinationIndex, 0, item)
  return getStatusBarStoredItems(settingsItems)
}

/** 設定画面の上下操作を保存配列の並び替えへ変換する。 */
export function moveStatusBarItemAtSettingsIndex(
  items: readonly StatusBarItemId[],
  sourceIndex: number,
  direction: -1 | 1,
): StatusBarItemId[] {
  return reorderStatusBarItemsAtSettingsIndex(items, sourceIndex, sourceIndex + direction)
}
