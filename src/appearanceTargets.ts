/** 配色の説明、実画面の代表箇所、見本を同じ対応表で管理する。保存形式には含めない。 */
import { colorDefinitions, type ColorKey } from './appearance'

export type ColorTargetKind = '背景' | '文字' | '枠線' | '記号'
export type ColorTargetDefinition = { description: string; kind: ColorTargetKind; selectors: string; sample: string }
export type ColorPreviewPart = { id: string; label: string; content: string; background: ColorKey; text: ColorKey; border?: ColorKey }

/** 同じ領域の色にも用途を明記し、CSSセレクターは実際の適用先を使用する。 */
function target(kind: ColorTargetKind, description: string, selectors: string, sample: string): ColorTargetDefinition {
  return { kind, description, selectors, sample }
}

export const colorTargets: Record<ColorKey, ColorTargetDefinition> = {
  background: target('背景', '画面全体の共通背景。本文や設定専用の背景は別項目です。', '.v-application', 'background'),
  surface: target('背景', '共通のカードやサイドバーのパネル。', '.sidebar-content, .sidebar-rail, .external-file-notice', 'surface'),
  surfaceLight: target('背景', '共通部品の補助面。専用色のあるパネルには適用されません。', '.bg-surface-light', 'surfaceLight'),
  text: target('文字', '共通部品やサイドバーの文字。各領域の専用文字色は別項目です。', '.sidebar-content, .sidebar-rail, .external-file-notice', 'surface'),
  muted: target('文字', '操作説明、保存場所、メニューのショートカット表示など。', '.setting-help, .appearance-help, .sidebar-help, .sidebar-result small, .menu-shortcut, .search-help, .quick-open-location', 'muted'),
  border: target('枠線', '共通の入力欄とサイドバーの境界。', '.v-field__outline, .sidebar-rail', 'surface'),
  primary: target('背景', '主要なボタンの背景や、選択中の機能を示すアクセント。', '.bg-primary, .text-primary, .sidebar-rail .v-btn[aria-pressed="true"]', 'primary'),
  onPrimary: target('文字', 'アクセント色を背景にした主要ボタンの文字。', '.bg-primary .v-btn__content, .bg-primary', 'primary'),
  hover: target('背景', '共通のボタンや一覧にマウスを合わせたときの背景。', '.v-btn:not(:disabled):hover, .v-list-item:hover, .sidebar-result:hover, .quick-open-result:hover', 'hover'),
  selected: target('背景', '選択中の共通ボタンや一覧項目の背景。', '.v-list-item--active, .v-btn--active, .sidebar-rail .v-btn[aria-pressed="true"], .sidebar-result[aria-selected="true"], .quick-open-result.is-selected', 'selected'),
  onSelected: target('文字', '選択中の共通ボタンや一覧項目の文字。', '.v-list-item--active, .v-btn--active, .sidebar-result[aria-selected="true"], .quick-open-result.is-selected', 'selected'),
  focus: target('枠線', 'キーボードで選んだ部品や、入力中の欄を示す枠。', ':focus-visible, .v-field--focused .v-field__outline', 'focus'),
  error: target('背景', 'エラー表示の背景・文字・入力欄の枠。用途により適用方法が異なります。', '.bg-error, .text-error, .v-field--error, .project-tree-row.is-unavailable', 'error'),
  warning: target('背景', '警告表示の背景や、外部変更通知の境界。', '.bg-warning, .text-warning, .external-file-notice, .git-next[data-tone="warning"]', 'warning'),
  info: target('背景', '情報通知の背景や、履歴画面の案内の境界。', '.bg-info, .text-info, .git-next[data-tone="info"]', 'info'),
  editorBackground: target('背景', '原稿を書く本文編集領域。', '.writing-area, .editor-host .cm-editor', 'editor'),
  editorText: target('文字', '原稿の本文。強調箇所の文字は別項目です。', '.editor-host .cm-content', 'editor'),
  caret: target('記号', '本文の入力位置を示す縦線。', '.editor-host .cm-cursor', 'caret'),
  selection: target('背景', '本文で選択した範囲の背景。', '.editor-host .cm-selectionBackground', 'selection'),
  selectionText: target('文字', '本文で選択した範囲の文字。', '.editor-host .cm-content', 'selection'),
  gutterBackground: target('背景', '本文左側にある行番号欄。行番号表示が有効なときに表示されます。', '.editor-host .cm-gutters', 'gutter'),
  gutterText: target('文字', '本文左側の行番号。', '.editor-host .cm-gutterElement', 'gutter'),
  gutterBorder: target('枠線', '行番号欄と本文の間の境界。', '.editor-host .cm-gutters', 'gutter'),
  whitespace: target('記号', '表示を有効にしたときの半角空白・全角空白・タブの記号。', '.editor-host .cm-highlightSpace, .editor-host .cm-highlightTab, .editor-host .cm-highlightFullWidthSpace', 'whitespace'),
  matchBackground: target('背景', '検索で一致した箇所の背景。現在の一致箇所は別項目です。', '.cm-searchMatch:not(.cm-searchMatch-selected), .sidebar-result mark', 'match'),
  matchText: target('文字', '検索で一致した箇所の文字。', '.cm-searchMatch:not(.cm-searchMatch-selected), .sidebar-result mark', 'match'),
  matchBorder: target('枠線', '本文内で検索に一致した箇所の枠。', '.cm-searchMatch:not(.cm-searchMatch-selected)', 'match'),
  currentMatchBackground: target('背景', '本文検索で現在選んでいる一致箇所の背景。', '.cm-searchMatch-selected', 'currentMatch'),
  currentMatchText: target('文字', '本文検索で現在選んでいる一致箇所の文字。', '.cm-searchMatch-selected', 'currentMatch'),
  currentMatchBorder: target('枠線', '本文検索で現在選んでいる一致箇所の枠。', '.cm-searchMatch-selected', 'currentMatch'),
  menuBarBackground: target('背景', 'メイン画面上部のメニューバー。', '.titlebar .v-toolbar__content', 'menuBar'),
  menuBarText: target('文字', 'メニューバーの項目名とアイコン。', '.titlebar .v-toolbar__content', 'menuBar'),
  menuBarBorder: target('枠線', 'メニューバー下端の境界。', '.titlebar .v-toolbar__content', 'menuBar'),
  toolbarBackground: target('背景', 'メニューバーの下にある操作アイコンのバー。', '.toolbar-strip', 'toolbar'),
  toolbarText: target('文字', 'ツールバーの操作アイコン。', '.toolbar-strip', 'toolbar'),
  toolbarBorder: target('枠線', 'ツールバー下端の境界。', '.toolbar-strip', 'toolbar'),
  statusBackground: target('背景', 'メイン画面下部のステータスバー。', '.status-bar', 'status'),
  statusText: target('文字', '文字数や現在位置などのステータス表示。', '.status-bar', 'status'),
  statusBorder: target('枠線', 'ステータスバー上端の境界。', '.status-bar', 'status'),
  treeBackground: target('背景', 'プロジェクトツリーの背景。分離ウィンドウにも適用されます。', '.project-tree-sidebar', 'tree'),
  treeText: target('文字', '通常のファイル名やフォルダ名。', '.project-tree-row:not(.is-active):not(.is-selected) .project-tree-node-name', 'tree'),
  treeMuted: target('文字', 'ツリーの見出し・保存場所・未登録時の案内。', '.project-tree-heading, .project-tree-origin, .project-tree-empty', 'treeMuted'),
  treeBorder: target('枠線', 'ツリー外枠と見出し・保存場所の境界。', '.project-tree-sidebar, .project-tree-header, .project-tree-origin', 'tree'),
  treeHover: target('背景', 'ツリーの行にマウスやフォーカスを合わせたときの背景。', '.project-tree-row:not(.is-active):not(.is-selected):hover, .project-tree-row:not(.is-active):not(.is-selected):focus-within', 'treeHover'),
  treeSelected: target('背景', 'ツリーで選択した行の背景。', '.project-tree-row.is-selected', 'treeSelected'),
  treeSelectedText: target('文字', 'ツリーで選択した行の名前。', '.project-tree-row.is-selected .project-tree-node-name', 'treeSelected'),
  treeActive: target('背景', '現在編集中の原稿の行。選択行の背景が優先されます。', '.project-tree-row.is-active:not(.is-selected)', 'treeActive'),
  treeActiveText: target('文字', '現在編集中の原稿の名前。選択行の文字色が優先されます。', '.project-tree-row.is-active:not(.is-selected) .project-tree-node-name', 'treeActive'),
  settingsBackground: target('背景', '設定画面で項目を編集する領域。', '.settings-main', 'settings'),
  settingsText: target('文字', '設定項目名と設定パネル内の文字。', '.settings-main', 'settings'),
  settingsNavBackground: target('背景', '設定画面左側のページ一覧。', '.settings-navigation', 'settingsNav'),
  settingsNavText: target('文字', '設定画面左側のページ名。', '.settings-navigation', 'settingsNav'),
  settingsHeaderBackground: target('背景', '設定画面上部のタイトルと履歴ボタンのバー。', '.settings-shell .v-app-bar', 'settingsHeader'),
  settingsHeaderText: target('文字', '設定画面上部のタイトルと履歴ボタン。', '.settings-shell .v-app-bar', 'settingsHeader'),
  settingsPanel: target('背景', '設定画面の展開パネル。', '.settings-shell .setting-expansion-section', 'settingsPanel'),
  searchBackground: target('背景', '独立した検索・置換ウィンドウ。', '.search-shell', 'search'),
  searchText: target('文字', '検索・置換ウィンドウの文字。', '.search-shell', 'search'),
  popupBackground: target('背景', '開いているポップアップメニュー。', '.v-menu > .v-overlay__content > .v-list, .v-menu > .v-overlay__content > .v-card', 'popup'),
  popupText: target('文字', '開いているポップアップメニューの文字。', '.v-menu > .v-overlay__content > .v-list, .v-menu > .v-overlay__content > .v-card', 'popup'),
  dialogBackground: target('背景', '確認や入力ダイアログのカード。', '.v-dialog > .v-overlay__content > .v-card', 'dialog'),
  dialogText: target('文字', '確認や入力ダイアログの文字。', '.v-dialog > .v-overlay__content > .v-card', 'dialog'),
}

/** 見本の各面に現在の配色キーを割り当て、適用色を重複定義しない。 */
function part(id: string, label: string, background: ColorKey, text: ColorKey, border?: ColorKey, content = label): ColorPreviewPart {
  return { id, label, background, text, border, content }
}

export const colorPreviewGroups: Record<string, readonly ColorPreviewPart[]> = {
  共通部品: [
    part('background', '画面背景', 'background', 'text'), part('surface', 'パネル・入力欄', 'surface', 'text', 'border'),
    part('surfaceLight', '補助パネル', 'surfaceLight', 'text'), part('muted', '操作説明', 'surface', 'muted'),
    part('primary', '主要ボタン', 'primary', 'onPrimary'), part('hover', 'ホバー中', 'hover', 'text'),
    part('selected', '選択中', 'selected', 'onSelected'), part('focus', '入力中', 'surface', 'text', 'focus'),
    part('error', 'エラー', 'error', 'text'), part('warning', '警告', 'warning', 'text'), part('info', '通知', 'info', 'text'),
  ],
  本文: [
    part('editor', '本文', 'editorBackground', 'editorText', undefined, '第一章　旅のはじまり'),
    part('selection', '選択範囲', 'selection', 'selectionText'), part('gutter', '行番号', 'gutterBackground', 'gutterText', 'gutterBorder', '1　2　3'),
    part('caret', 'カーソル', 'editorBackground', 'caret', undefined, '│'), part('whitespace', '空白・タブ', 'editorBackground', 'whitespace', undefined, '·　□　→'),
  ],
  検索強調: [part('match', '一致箇所', 'matchBackground', 'matchText', 'matchBorder'), part('currentMatch', '現在の一致箇所', 'currentMatchBackground', 'currentMatchText', 'currentMatchBorder')],
  各バー: [part('menuBar', 'ファイル　編集　表示', 'menuBarBackground', 'menuBarText', 'menuBarBorder'), part('toolbar', 'ツールバー', 'toolbarBackground', 'toolbarText', 'toolbarBorder', '＋　▣　↶　↷'), part('status', '文字数・現在位置', 'statusBackground', 'statusText', 'statusBorder', '1,234文字　3行 8列')],
  プロジェクトツリー: [part('tree', '通常の行', 'treeBackground', 'treeText', 'treeBorder', '第一章.txt'), part('treeMuted', '保存場所・案内', 'treeBackground', 'treeMuted'), part('treeHover', 'ホバー中の行', 'treeHover', 'treeText'), part('treeSelected', '選択行', 'treeSelected', 'treeSelectedText'), part('treeActive', '編集中の行', 'treeActive', 'treeActiveText')],
  設定画面: [part('settings', '項目編集領域', 'settingsBackground', 'settingsText'), part('settingsNav', 'ページ一覧', 'settingsNavBackground', 'settingsNavText'), part('settingsHeader', '設定タイトル', 'settingsHeaderBackground', 'settingsHeaderText'), part('settingsPanel', '設定パネル', 'settingsPanel', 'settingsText')],
  '検索画面・メニュー・ダイアログ': [part('search', '検索・置換画面', 'searchBackground', 'searchText'), part('popup', 'ポップアップメニュー', 'popupBackground', 'popupText'), part('dialog', '確認ダイアログ', 'dialogBackground', 'dialogText')],
}

/** マウスを移しても入力中の行を優先し、確定処理やUndoには関与しない。 */
export function createColorTargetInteraction(onChange: (key: ColorKey | null) => void) {
  let hovered: ColorKey | null = null
  let focused: ColorKey | null = null
  let current: ColorKey | null = null
  /** 同じ対象は通知せず、フォーカスがなければホバー対象を使う。 */
  function update(): void {
    const next = focused ?? hovered
    if (next === current) return
    current = next
    onChange(next)
  }
  /** 行からの離脱はその行だけを解除し、後から届く別行の離脱を無視する。 */
  function hover(key: ColorKey, active: boolean): void { if (active) hovered = key; else if (hovered === key) hovered = null; update() }
  /** 行内のフォーカス移動は呼び出し側で除外し、別行への移動だけを受け取る。 */
  function focus(key: ColorKey, active: boolean): void { if (active) focused = key; else if (focused === key) focused = null; update() }
  /** ページ移動・折りたたみ・ダイアログ表示時は両方の対象を破棄する。 */
  function clear(): void { hovered = null; focused = null; update() }
  return { hover, focus, clear }
}

/** 全項目で見本の対応を取得し、見本未選択時は共通部品を表示する。 */
export function getColorPreviewParts(key: ColorKey | null): readonly ColorPreviewPart[] {
  const parts = colorPreviewGroups[key ? colorDefinitions[key][0] : '共通部品']
  if (!key) return parts.slice(0, 3)
  const selected = parts.find(part => part.id === colorTargets[key].sample)!
  return [selected, ...parts.filter(part => part !== selected).slice(0, 2)]
}
