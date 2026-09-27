import { computed, ref } from 'vue'

type MainMenuId = 'file' | 'edit' | 'project' | 'settings' | 'display' | 'window'

type MainMenuStateOptions = {
  closeProjectSubmenu: () => boolean
  closeProjectMenus: () => void
}

/** メニューバーの排他表示と、設定・プロジェクトの二段階Esc操作を管理する。 */
export function useMainMenuState(options: MainMenuStateOptions) {
  const openMenu = ref<MainMenuId | null>(null)
  const settingsSubmenuOpen = ref(false)

  /** 指定したトップレベルメニューだけを開く双方向computedを作成する。 */
  function createMenuModel(menuId: MainMenuId) {
    return computed({
      get: (): boolean => openMenu.value === menuId,
      set: (value: boolean): void => {
        if (value) {
          settingsSubmenuOpen.value = false
          if (menuId !== 'project') options.closeProjectMenus()
          openMenu.value = menuId
        } else if (openMenu.value === menuId) {
          openMenu.value = null
        }
      },
    })
  }

  const fileMenuOpen = createMenuModel('file')
  const editMenuOpen = createMenuModel('edit')
  const projectMenuOpen = createMenuModel('project')
  const displayMenuOpen = createMenuModel('display')
  const windowMenuOpen = createMenuModel('window')
  const settingsMenuOpen = computed({
    get: (): boolean => openMenu.value === 'settings',
    set: (value: boolean): void => {
      if (value) {
        options.closeProjectMenus()
        openMenu.value = 'settings'
      } else {
        settingsSubmenuOpen.value = false
        if (openMenu.value === 'settings') openMenu.value = null
      }
    },
  })

  /** 全トップレベルメニューと、そのサブメニューを閉じる。 */
  function closeMenus(): void {
    openMenu.value = null
    settingsSubmenuOpen.value = false
    options.closeProjectMenus()
  }

  /** プロジェクト操作前に全メニューを閉じ、操作を呼び出し元へ渡す。 */
  function runProjectAction(action: () => void): void {
    closeMenus()
    action()
  }

  /** Escでサブメニューを先に閉じ、次のEscで親メニューを閉じる。 */
  function handleEscape(): boolean {
    if (settingsSubmenuOpen.value) {
      settingsSubmenuOpen.value = false
      return true
    }
    if (openMenu.value === 'project' && options.closeProjectSubmenu()) return true
    if (!openMenu.value) return false
    closeMenus()
    return true
  }

  return {
    settingsSubmenuOpen,
    fileMenuOpen,
    editMenuOpen,
    projectMenuOpen,
    settingsMenuOpen,
    displayMenuOpen,
    windowMenuOpen,
    closeMenus,
    runProjectAction,
    handleEscape,
  }
}
