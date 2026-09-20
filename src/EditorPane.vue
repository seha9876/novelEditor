<script setup lang="ts">
// CodeMirror の生成・破棄と本文編集を担当し、親には本文と文字数だけを通知する。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { EditorSettings } from './editorSettings'
import type { LineEnding } from './textFile'

const props = defineProps<{ settings: EditorSettings }>()
const emit = defineEmits<{
  change: [text: string, count: number]
}>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | undefined
const wrapping = new Compartment()

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
  '.cm-content': {
    boxSizing: 'border-box',
    minHeight: '100%',
    fontFamily: '"Yu Mincho", "Hiragino Mincho ProN", "MS PMincho", serif',
    fontSize: '18px',
    lineHeight: '1.9',
    caretColor: '#263c4a',
  },
  '.cm-line': { padding: '0' },
  '.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: '#263c4a' },
  '.cm-selectionBackground': { backgroundColor: '#dce8ed !important' },
  '.cm-gutters': { display: 'none' },
})

/** 指定した本文と改行形式から独立した編集状態を作る。履歴も含め、文書切り替え時に以前の操作を残さない。 */
function createState(text: string, lineEnding: LineEnding): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      // 読み込んだ改行形式を CodeMirror の改行処理へ渡す。書き出し時の復元は textFile 側で行う。
      EditorState.lineSeparator.of(lineEnding),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      wrapping.of(props.settings.wrapMode === 'none' ? [] : EditorView.lineWrapping),
      // 文書変更時だけ親へ通知し、選択範囲の移動などでは未保存判定を更新しない。
      EditorView.updateListener.of((update) => {
        if (update.docChanged) reportChange()
      }),
      editorTheme,
    ],
  })
}

/** 折り返し方法と表示幅を本文へ反映する。文書と編集履歴は変更しない。 */
function applyWrapSettings(settings: EditorSettings): void {
  if (!host.value) return
  host.value.dataset.wrapMode = settings.wrapMode
  host.value.dataset.narrowWrapBehavior = settings.narrowWrapBehavior
  host.value.style.setProperty('--wrap-column-width', `${settings.wrapColumns}ch`)
  view?.dispatch({ effects: wrapping.reconfigure(settings.wrapMode === 'none' ? [] : EditorView.lineWrapping) })
}

watch(() => props.settings, applyWrapSettings)

/** 現在の本文と改行を除いた文字数を親へ通知する。親側の表示と未保存判定に影響する。 */
function reportChange(): void {
  const text = getText()
  // 文字数は改行を除いた Unicode コードポイント数とする。
  emit('change', text, Array.from(text.replace(/\r\n|\r|\n/g, '')).length)
}

/** CodeMirror が保持する本文を返す。未生成の場合は空文字とする。 */
function getText(): string {
  return view?.state.doc.toString() ?? ''
}

/** 本文と改行形式を切り替え、変更を親へ通知する。既定の改行形式は LF。 */
function setDocument(text: string, lineEnding: LineEnding = '\n'): void {
  // 文書の切り替え時に状態ごと作り直し、前の文書の Undo 履歴を持ち越さない。
  view?.setState(createState(text, lineEnding))
  reportChange()
}

/** 本文の CodeMirror ビューへ入力フォーカスを移す。 */
function focus(): void {
  view?.focus()
}

// 親は本文を複製保持せず、保存時に公開したメソッドから CodeMirror の現在値を読む。
defineExpose({ getText, setDocument, focus })

// Vue の要素確定後に CodeMirror を配置し、初期文字数を親へ通知する。
onMounted(() => {
  if (!host.value) return
  applyWrapSettings(props.settings)
  view = new EditorView({ state: createState('', '\n'), parent: host.value })
  reportChange()
})

// Vue の破棄時に CodeMirror のイベントや DOM 参照を解放する。
onBeforeUnmount(() => {
  view?.destroy()
})
</script>

<template>
  <div ref="host" class="editor-host" aria-label="本文" />
</template>
