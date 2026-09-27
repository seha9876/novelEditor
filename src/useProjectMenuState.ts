import { computed, ref, watch, type Ref } from 'vue'

/** 親から渡された開閉状態と切替サブメニューをまとめて管理する。 */
export function useProjectMenuState(options: {
  modelValue: Ref<boolean>
  onUpdateModelValue: (value: boolean) => void
}) {
  const switchMenuOpen = ref(false)
  const menuOpen = computed({
    get: (): boolean => options.modelValue.value,
    set: (value: boolean): void => {
      if (!value) switchMenuOpen.value = false
      options.onUpdateModelValue(value)
    },
  })

  watch(menuOpen, (isOpen) => {
    if (!isOpen) switchMenuOpen.value = false
  })

  /** 開いている切替サブメニューだけを閉じ、親メニューの状態を維持する。 */
  function closeSubmenu(): boolean {
    if (!switchMenuOpen.value) return false
    switchMenuOpen.value = false
    return true
  }

  /** プロジェクトメニューと切替サブメニューを同時に閉じる。 */
  function closeMenus(): void {
    closeSubmenu()
    menuOpen.value = false
  }

  /** プロジェクト操作前にメニューを閉じ、操作を呼び出し元へ渡す。 */
  function runAction(action: () => void): void {
    closeMenus()
    action()
  }

  return {
    menuOpen,
    switchMenuOpen,
    closeSubmenu,
    closeMenus,
    runAction,
  }
}
