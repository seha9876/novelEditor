/** メニューバー・ツールバー・ステータスバーの表示寸法を設定値から導出する。 */
import type { InterfaceBarSizes, InterfaceSize, ToolbarSize } from './appPreferenceSchema'

/** 保存値の各サイズを、バーごとの外側寸法と内部コントロール寸法へ変換する。 */
const interfaceBarSizePresets = {
  'extra-small': {
    toolbar: {
      height: 32,
      buttonHeight: 24,
      buttonWidth: 24,
      iconSize: 16,
      fontSize: '0.625rem',
      padding: 4,
      gap: 2,
      itemMargin: 0,
      dividerHeight: 16,
      dividerMargin: 2,
    },
  },
  small: {
    menu: {
      height: 28,
      controlHeight: 24,
      iconSize: 18,
      fontSize: '0.6875rem',
      titleFontSize: '0.75rem',
      secondaryFontSize: '0.6875rem',
      windowControlWidth: 40,
      buttonPadding: 8,
      padding: 4,
      gap: 1,
      titleGap: 6,
      titlePadding: 8,
    },
    toolbar: {
      height: 40,
      buttonHeight: 32,
      buttonWidth: 32,
      iconSize: 18,
      fontSize: '0.6875rem',
      padding: 4,
      gap: 3,
      itemMargin: 1,
      dividerHeight: 20,
      dividerMargin: 3,
    },
    status: {
      height: 30,
      fontSize: '0.6875rem',
      gap: 12,
      padding: 8,
      buttonHeight: 24,
      buttonPadding: 8,
      buttonFontSize: '0.6875rem',
      buttonIconSize: 16,
    },
  },
  medium: {
    menu: {
      height: 32,
      controlHeight: 28,
      iconSize: 20,
      fontSize: '0.75rem',
      titleFontSize: '0.875rem',
      secondaryFontSize: '0.75rem',
      windowControlWidth: 46,
      buttonPadding: 12,
      padding: 8,
      gap: 2,
      titleGap: 8,
      titlePadding: 12,
    },
    toolbar: {
      height: 48,
      buttonHeight: 40,
      buttonWidth: 40,
      iconSize: 20,
      fontSize: '0.75rem',
      padding: 4,
      gap: 4,
      itemMargin: 2,
      dividerHeight: 24,
      dividerMargin: 4,
    },
    status: {
      height: 36,
      fontSize: '0.75rem',
      gap: 16,
      padding: 12,
      buttonHeight: 28,
      buttonPadding: 12,
      buttonFontSize: '0.75rem',
      buttonIconSize: 18,
    },
  },
  large: {
    menu: {
      height: 40,
      controlHeight: 36,
      iconSize: 24,
      fontSize: '0.875rem',
      titleFontSize: '1rem',
      secondaryFontSize: '0.8125rem',
      windowControlWidth: 54,
      buttonPadding: 16,
      padding: 12,
      gap: 3,
      titleGap: 10,
      titlePadding: 16,
    },
    toolbar: {
      height: 56,
      buttonHeight: 48,
      buttonWidth: 48,
      iconSize: 24,
      fontSize: '0.875rem',
      padding: 4,
      gap: 6,
      itemMargin: 3,
      dividerHeight: 32,
      dividerMargin: 5,
    },
    status: {
      height: 44,
      fontSize: '0.875rem',
      gap: 20,
      padding: 16,
      buttonHeight: 36,
      buttonPadding: 16,
      buttonFontSize: '0.875rem',
      buttonIconSize: 22,
    },
  },
} as const

type InterfaceBarMetrics = {
  menu: typeof interfaceBarSizePresets[InterfaceSize]['menu']
  toolbar: typeof interfaceBarSizePresets[ToolbarSize]['toolbar']
  status: typeof interfaceBarSizePresets[InterfaceSize]['status']
}

/** 3本のバーに適用する内部寸法を設定値から取得する。 */
export function getInterfaceBarMetrics(sizes: InterfaceBarSizes): InterfaceBarMetrics {
  return {
    menu: interfaceBarSizePresets[sizes.menu].menu,
    toolbar: interfaceBarSizePresets[sizes.toolbar].toolbar,
    status: interfaceBarSizePresets[sizes.status].status,
  }
}

/** 指定したバーとサイズの外側の高さを返す。極小はツールバーだけで有効とする。 */
export function getInterfaceBarHeight(bar: keyof InterfaceBarMetrics, size: InterfaceSize | ToolbarSize): number {
  if (bar === 'toolbar') return interfaceBarSizePresets[size].toolbar.height
  const normalizedSize = size === 'extra-small' ? 'medium' : size
  return interfaceBarSizePresets[normalizedSize][bar].height
}

/** レイアウトと内部コントロールへバーの寸法をCSSカスタムプロパティで渡す。 */
export function createInterfaceBarStyle(sizes: InterfaceBarSizes): Record<string, string> {
  const metrics = getInterfaceBarMetrics(sizes)
  return {
    '--menu-bar-height': `${metrics.menu.height}px`,
    '--menu-control-height': `${metrics.menu.controlHeight}px`,
    '--menu-icon-size': `${metrics.menu.iconSize}px`,
    '--menu-font-size': metrics.menu.fontSize,
    '--menu-title-font-size': metrics.menu.titleFontSize,
    '--menu-secondary-font-size': metrics.menu.secondaryFontSize,
    '--window-control-width': `${metrics.menu.windowControlWidth}px`,
    '--menu-button-padding': `${metrics.menu.buttonPadding}px`,
    '--menu-bar-padding': `${metrics.menu.padding}px`,
    '--menu-bar-gap': `${metrics.menu.gap}px`,
    '--menu-title-gap': `${metrics.menu.titleGap}px`,
    '--menu-title-padding': `${metrics.menu.titlePadding}px`,
    '--toolbar-bar-height': `${metrics.toolbar.height}px`,
    '--toolbar-button-height': `${metrics.toolbar.buttonHeight}px`,
    '--toolbar-button-width': `${metrics.toolbar.buttonWidth}px`,
    '--toolbar-icon-size': `${metrics.toolbar.iconSize}px`,
    '--toolbar-font-size': metrics.toolbar.fontSize,
    '--toolbar-bar-padding': `${metrics.toolbar.padding}px`,
    '--toolbar-bar-gap': `${metrics.toolbar.gap}px`,
    '--toolbar-item-margin': `${metrics.toolbar.itemMargin}px`,
    '--toolbar-divider-height': `${metrics.toolbar.dividerHeight}px`,
    '--toolbar-divider-margin': `${metrics.toolbar.dividerMargin}px`,
    '--status-bar-height': `${metrics.status.height}px`,
    '--status-font-size': metrics.status.fontSize,
    '--status-gap': `${metrics.status.gap}px`,
    '--status-bar-padding': `${metrics.status.padding}px`,
    '--status-button-height': `${metrics.status.buttonHeight}px`,
    '--status-button-padding': `${metrics.status.buttonPadding}px`,
    '--status-button-font-size': metrics.status.buttonFontSize,
    '--status-button-icon-size': `${metrics.status.buttonIconSize}px`,
  }
}
