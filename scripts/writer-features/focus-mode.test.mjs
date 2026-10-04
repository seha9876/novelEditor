/** 集中モードの操作経路と、表示設定・フォーカスの保全を検証する。 */
import { assert, loadSourceModule, projectRoot, readFileSync, require, resolve, test, ts } from './test-support.mjs'

test('集中モードはF10とツールバーから使え、IME・修飾キー・Escとは競合しない', () => {
  const { findShortcutCommand, getToolbarCommandDefinitions } = loadSourceModule('src/appCommands.ts')
  const event = { key: 'F10', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
  assert.equal(findShortcutCommand(event)?.id, 'view.focusMode.toggle')
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { metaKey: true }, { key: 'Escape' }]) {
    assert.equal(findShortcutCommand({ ...event, ...extra }), undefined)
  }
  const toolbarIds = getToolbarCommandDefinitions().map(({ id }) => id)
  assert.equal(toolbarIds.includes('view.focusMode.toggle'), true)
  assert.equal(toolbarIds.includes('view.lineNumbers.toggle'), true)
})

/** Appの実際の切替処理を取り出し、DOMと描画待ちだけを置き換える。 */
function createFocusModeHarness() {
  const vue = require('vue')
  const source = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const parsed = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true)
  const statements = parsed.statements.filter((node) => (
    ts.isFunctionDeclaration(node) && node.name?.text === 'toggleFocusMode'
  ) || (
    ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === 'focusMode')
  ))
  const compiled = ts.transpileModule(statements.map((node) => node.getText(parsed)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  class Element {
    /** 隠れるツリー・ツールバーと他の入力先を区別する。 */
    constructor(hiddenRegion = false) { this.hiddenRegion = hiddenRegion }
    /** DOM祖先の照会をテスト用の領域属性で再現する。 */
    closest() { return this.hiddenRegion ? this : null }
  }
  const document = { body: new Element(), activeElement: null }
  let focused = 0
  let afterTick = () => {}
  const documentLocked = vue.ref(false)
  const mainCloseInProgress = vue.ref(false)
  const editor = vue.ref({ focus: () => { focused += 1 } })
  const app = new Function('ref', 'nextTick', 'document', 'HTMLElement', 'editor', 'documentLocked', 'mainCloseInProgress',
    `${compiled}\nreturn { focusMode, toggleFocusMode }`)(
    vue.ref, async () => { afterTick() }, document, Element, editor, documentLocked, mainCloseInProgress,
  )
  return { app, Element, document, documentLocked, mainCloseInProgress, focusCount: () => focused, onTick: (callback) => { afterTick = callback } }
}

test('集中モードは非永続で、隠れる領域のフォーカスだけ本文へ戻す', async () => {
  const harness = createFocusModeHarness()
  const { app, document, Element } = harness
  assert.equal(app.focusMode.value, false)
  document.activeElement = new Element(true)
  await app.toggleFocusMode()
  assert.equal(app.focusMode.value, true)
  assert.equal(harness.focusCount(), 1)
  await app.toggleFocusMode()
  assert.equal(app.focusMode.value, false)
  assert.equal(harness.focusCount(), 1)
  document.activeElement = new Element(false)
  await app.toggleFocusMode()
  assert.equal(harness.focusCount(), 1, 'メニューやモーダル入力からフォーカスを奪わない')
  assert.equal(createFocusModeHarness().app.focusMode.value, false, '次のアプリ起動はOFF')
})

test('集中モードの描画待ち中に入力先や文書ロックが変わってもフォーカスを奪わない', async () => {
  for (const change of ['dialog', 'locked', 'closing', 'body']) {
    const harness = createFocusModeHarness()
    harness.document.activeElement = new harness.Element(true)
    harness.onTick(() => {
      if (change === 'dialog') harness.document.activeElement = new harness.Element(false)
      if (change === 'locked') harness.documentLocked.value = true
      if (change === 'closing') harness.mainCloseInProgress.value = true
      if (change === 'body') harness.document.activeElement = harness.document.body
    })
    await harness.app.toggleFocusMode()
    assert.equal(harness.focusCount(), change === 'body' ? 1 : 0, change)
  }
})

test('集中モードはツリーのマウントを維持し、保存設定と実効表示を分離する', () => {
  const app = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const bar = readFileSync(resolve(projectRoot, 'src/MainAppBar.vue'), 'utf8')
  const styles = readFileSync(resolve(projectRoot, 'src/styles/project-tree.css'), 'utf8')
  const drawer = app.match(/<VNavigationDrawer[\s\S]*?>/)[0]
  assert.doesNotMatch(drawer, /v-if/)
  assert.match(drawer, /'is-focus-hidden': focusMode/)
  assert.match(styles, /\.project-navigation\.is-focus-hidden \{ display: none !important; \}/)
  assert.match(drawer, /:model-value="!focusMode"/)
  assert.match(bar, /:extended="props.toolbarVisible && !props.focusMode"/)
  assert.match(bar, /v-if="props.toolbarVisible && !props.focusMode"/)
  assert.match(bar, /:toolbar-visible="props.toolbarVisible"/)
  assert.doesNotMatch(app.match(/<VFooter[\s\S]*?>/)[0], /focusMode/)
  assert.doesNotMatch(app.match(/<EditorPane[\s\S]*?\/>/)[0], /focusMode/)
})
