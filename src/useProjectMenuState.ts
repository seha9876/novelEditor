import { computed, ref, watch, type Ref } from 'vue'

/** プロジェクトメニューの親制御・内部制御と切替サブメニューをまとめて管理する。 */
export function useProjectMenuState(options: {
  modelValue?: Ref<boolean | undefined>
  onUpdateModelValue?: (value: boolean) => void
} = {}) {
  const internalMenuOpen = ref(false)
  const switchMenuOpen = ref(false)
  const menuOpen = computed({
    get: (): boolean => options.modelValue?.value ?? internalMenuOpen.value,
    set: (value: boolean): void => {
      if (!value) switchMenuOpen.value = false
      if (options.modelValue?.value === undefined) {
        internalMenuOpen.value = value
      } else {
        options.onUpdateModelValue?.(value)
      }
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
