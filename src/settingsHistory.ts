/** 設定変更のUndo／Redo履歴を、設定画面や保存処理から独立して管理する。 */
import { cloneSettingsValues, type SettingsValues } from './settingsValues'

type SettingsHistory = {
  readonly active: boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
  beginSession: () => void
  endSession: () => void
  clear: () => void
  push: (value: SettingsValues) => void
  undo: (current: SettingsValues) => SettingsValues | null
  redo: (current: SettingsValues) => SettingsValues | null
}

/** 設定値を最大件数まで保持し、現在の設定を渡してUndo／Redoを行う。 */
export function createSettingsHistory(limit = 100): SettingsHistory {
  const undoHistory: SettingsValues[] = []
  const redoHistory: SettingsValues[] = []
  let active = false

  /** Undo／Redo履歴を空にする。 */
  function clear(): void {
    undoHistory.length = 0
    redoHistory.length = 0
  }

  /** 設定ウィンドウの表示に合わせて新しい履歴セッションを開始する。 */
  function beginSession(): void {
    clear()
    active = true
  }

  /** 設定ウィンドウを閉じたときに履歴セッションを破棄する。 */
  function endSession(): void {
    active = false
    clear()
  }

  /** 現在値をUndo履歴へ追加し、分岐したRedo履歴を破棄する。 */
  function push(value: SettingsValues): void {
    if (!active) return
    undoHistory.push(cloneSettingsValues(value))
    if (undoHistory.length > limit) undoHistory.shift()
    redoHistory.length = 0
  }

  /** 直前値を返し、Undo前の現在値をRedo履歴へ積む。 */
  function undo(current: SettingsValues): SettingsValues | null {
    const previous = undoHistory.pop()
    if (!previous) return null
    redoHistory.push(cloneSettingsValues(current))
    return cloneSettingsValues(previous)
  }

  /** 取り消した値を返し、Redo前の現在値をUndo履歴へ積む。 */
  function redo(current: SettingsValues): SettingsValues | null {
    const next = redoHistory.pop()
    if (!next) return null
    undoHistory.push(cloneSettingsValues(current))
    return cloneSettingsValues(next)
  }

  return {
    get active() { return active },
    get canUndo() { return undoHistory.length > 0 },
    get canRedo() { return redoHistory.length > 0 },
    beginSession,
    endSession,
    clear,
    push,
    undo,
    redo,
  }
}
