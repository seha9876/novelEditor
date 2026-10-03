/** 左端の固定4パネルと、本文内の世代付き移動契約を定義する。 */
export type SidebarPanelId = 'project' | 'search' | 'history' | 'outline'
export type SidebarPreferences = { width: number; collapsed: boolean; activePanel: SidebarPanelId }
export const sidebarPanels = [
  { id: 'project', label: 'プロジェクト', icon: 'mdi-folder-outline' },
  { id: 'search', label: '検索', icon: 'mdi-magnify' },
  { id: 'history', label: '履歴', icon: 'mdi-history' },
  { id: 'outline', label: 'アウトライン', icon: 'mdi-format-list-bulleted' },
] as const
export type DocumentSnapshot = { revision: number; text: string; head: number; scope: { from: number; to: number } | null }
export type DocumentNavigation = { revision: number; from: number; to: number }

/** 旧ツリー設定を共通サイドバーへ引き継ぎ、未知のパネルはプロジェクトに戻す。 */
export function normalizeSidebar(value: unknown, legacy: { width: number; collapsed: boolean }): SidebarPreferences {
  const raw = value && typeof value === 'object' ? value as Partial<SidebarPreferences> : {}
  return { width: typeof raw.width === 'number' && Number.isFinite(raw.width) ? Math.max(220, Math.min(480, Math.round(raw.width))) : legacy.width,
    collapsed: typeof raw.collapsed === 'boolean' ? raw.collapsed : legacy.collapsed,
    activePanel: sidebarPanels.some(panel => panel.id === raw.activePanel) ? raw.activePanel! : 'project' }
}
