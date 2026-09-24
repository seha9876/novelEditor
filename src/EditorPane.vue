<script setup lang="ts">
// CodeMirror の生成・破棄、本文編集、別ウィンドウからの検索操作を担当する。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { editorFontCss, type EditorSettings } from './editorSettings'
import { createEmptyStatistics, StatisticsController, type EditorStatistics, type SelectionStatisticsInput } from './editorStatistics'
import { getSearchQuery } from '@codemirror/search'
import { createSearchExtensions, getEditorSearchStatus, runEditorSearchAction, updateEditorSearch } from './searchPanel'
import { createSearchConditions, type SearchAction, type SearchConditions, type SearchStatus } from './searchSession'

const props = defineProps<{ settings: EditorSettings; readOnly: boolean }>()
const emit = defineEmits<{
  change: [text: string]
  statistics: [statistics: EditorStatistics]
  searchStatus: [status: SearchStatus]
  searchNavigate: [action: SearchAction]
}>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | undefined
let statistics: StatisticsController | undefined
let searchConditions = createSearchConditions()
let searchActive = false
const wrapping = new Compartment()
const readOnlySetting = new Compartment()

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
  '.cm-content': {
    boxSizing: 'border-box',
    minHeight: '100%',
    fontFamily: 'var(--editor-font-family)',
    fontSize: 'var(--editor-font-size)',
    lineHeight: 'var(--editor-line-height)',
    caretColor: '#263c4a',
  },
  '.cm-line': { padding: '0' },
  '.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: '#263c4a' },
  '.cm-selectionBackground': { backgroundColor: '#dce8ed !important' },
  '.cm-gutters': { display: 'none' },
})

/** 本文をLFの内部表現へ揃え、検索と履歴も含めて独立した編集状態を作る。 */
function createState(text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      // 改行形式の指定を省くと混在改行もLFに揃う。元の形式への書き戻しはtextFileが担当する。
      readOnlySetting.of(EditorState.readOnly.of(props.readOnly)),
      history(),
      createSearchExtensions((action) => emit('searchNavigate', action)),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      wrapping.of(props.settings.wrapMode === 'none' ? [] : EditorView.lineWrapping),
      // 文書変更時だけ親へ通知し、選択範囲の移動などでは未保存判定を更新しない。
      EditorView.updateListener.of((update) => {
        if (update.docChanged) reportChange()
        else if (update.selectionSet) statistics?.updateSelection(getSelectionStatisticsInput())
        if (update.docChanged || !getSearchQuery(update.startState).eq(getSearchQuery(update.state))) reportSearchStatus()
      }),
      editorTheme,
    ],
  })
}

/** 書体と折り返し幅を反映し、再計測する。文書・選択・編集履歴は変更しない。 */
function applyWrapSettings(settings: EditorSettings): void {
  if (!host.value) return
  host.value.dataset.wrapMode = settings.wrapMode
  host.value.dataset.narrowWrapBehavior = settings.narrowWrapBehavior
  host.value.style.setProperty('--wrap-column-width', `${settings.wrapColumns}ch`)
  host.value.style.setProperty('--editor-font-family', editorFontCss(settings))
  host.value.style.setProperty('--editor-font-size', `${settings.fontSize}px`)
  host.value.style.setProperty('--editor-line-height', String(settings.lineHeight))
  view?.dispatch({ effects: wrapping.reconfigure(settings.wrapMode === 'none' ? [] : EditorView.lineWrapping) })
  view?.requestMeasure()
}

watch(() => props.settings, applyWrapSettings)
watch(() => props.readOnly, (value) => {
  view?.dispatch({ effects: readOnlySetting.reconfigure(EditorState.readOnly.of(value)) })
}, { flush: 'sync' })

/** 本文だけを親の未保存判定へ通知し、文字数は独立した非同期処理へ予約する。 */
function reportChange(resetStatistics = false): void {
  const text = getText()
  emit('change', text)
  statistics?.updateDocument(text, getSelectionStatisticsInput(), resetStatistics)
}

/** 重複しないCodeMirrorの選択範囲と主カーソルの行を、計数専用の入力へ変換する。 */
function getSelectionStatisticsInput(): SelectionStatisticsInput {
  if (!view) return { ranges: [], line: '', offset: 0, lineNumber: 1, lineCount: 1 }
  const { doc, selection } = view.state
  const line = doc.lineAt(selection.main.head)
  return {
    ranges: selection.ranges.filter((range) => !range.empty).map((range) => doc.sliceString(range.from, range.to)),
    line: line.text, offset: selection.main.head - line.from,
    lineNumber: line.number, lineCount: doc.lines,
  }
}

/** CodeMirror が保持する本文を返す。未生成の場合は空文字とする。 */
function getText(): string {
  return view?.state.doc.toString() ?? ''
}

/** 本文を切り替え、変更を親へ通知する。元の改行形式は親が保存用に保持する。 */
function setDocument(text: string): void {
  // 文書の切り替え時に状態ごと作り直し、前の文書の Undo 履歴を持ち越さない。
  view?.setState(createState(text))
  if (view) updateEditorSearch(view, searchConditions, searchActive)
  reportChange(true)
  reportSearchStatus()
}

/** 本文の CodeMirror ビューへ入力フォーカスを移す。 */
function focus(): void {
  view?.focus()
}

/** 共有条件を本文へ反映し、文書切替後にも同じ条件で検索できるよう保持する。 */
function setSearch(conditions: SearchConditions, active: boolean): void {
  searchConditions = { ...conditions }
  searchActive = active
  if (view) updateEditorSearch(view, searchConditions, searchActive)
  reportSearchStatus()
}

/** 別ウィンドウの要求を本文の選択とUndo履歴へ適用する。入力フォーカスは移動しない。 */
function runSearch(action: SearchAction): void {
  if (view) runEditorSearchAction(view, action)
  reportSearchStatus()
}

/** 本文と条件から求めた結果だけを親へ返す。本文全体は検索ウィンドウへ渡さない。 */
function reportSearchStatus(): void {
  if (view) emit('searchStatus', getEditorSearchStatus(view))
}

// 親は本文を複製保持せず、保存時に公開したメソッドから CodeMirror の現在値を読む。
defineExpose({ getText, setDocument, focus, setSearch, runSearch })

// Vue の要素確定後に CodeMirror を配置し、初期文字数を親へ通知する。
onMounted(() => {
  if (!host.value) return
  applyWrapSettings(props.settings)
  view = new EditorView({ state: createState(''), parent: host.value })
  try {
    statistics = new StatisticsController(
      new Worker(new URL('./statistics.worker.ts', import.meta.url), { type: 'module' }),
      (value) => emit('statistics', value),
    )
  } catch {
    emit('statistics', { ...createEmptyStatistics(), pending: false, error: '文字数の集計を開始できませんでした。' })
  }
  reportChange()
})

// Vue の破棄時に CodeMirror のイベントや DOM 参照を解放する。
onBeforeUnmount(() => {
  view?.destroy()
  statistics?.dispose()
})
</script>

<template>
  <div ref="host" class="editor-host" aria-label="本文" />
</template>
