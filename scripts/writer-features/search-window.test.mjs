/** 検索窓の実際の操作関数で、範囲指定と置換の通信競合を検証する。 */
import { assert, deferred, loadSourceModule, projectRoot, readFileSync, require, resolve, test, ts } from './test-support.mjs'

/** SFCの状態と関数を読み込み、ウィンドウの購読処理と送信先だけを置き換える。 */
function createWindowHarness(emitTo) {
  const source = readFileSync(resolve(projectRoot, 'src/SearchApp.vue'), 'utf8')
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const parsed = ts.createSourceFile('SearchApp.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarations = parsed.statements.filter((node) => ts.isVariableStatement(node) || ts.isFunctionDeclaration(node))
  const compiled = ts.transpileModule(declarations.map((node) => node.getText(parsed)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const { ref, computed, nextTick } = require('vue')
  const { createSearchConditions, createSearchScopeStatus } = loadSourceModule('src/searchSession.ts')
  const harness = new Function('ref', 'computed', 'nextTick', 'emitTo', 'window', 'createSearchConditions', 'SEARCH_COMMAND_EVENT', `${compiled}
    return { canRun, pending, scopeDisabled, errorMessage, sendScope, sendChange, receiveSnapshot, wait: () => sendQueue }`)(
    ref, computed, nextTick, emitTo, { location: { search: '?session=test' } }, createSearchConditions, 'search-command',
  )
  const initial = {
    sessionId: 'test', conditions: { ...createSearchConditions(), search: '星', replace: '月' },
    scope: { ...createSearchScopeStatus(), canCapture: true }, status: 'found', locked: false,
    documentRevision: 1, acknowledgedSequence: 0, revision: 1, focus: { field: 'search', revision: 0 }, error: '',
  }
  harness.receiveSnapshot(initial)
  return { ...harness, initial }
}

test('範囲指定の応答前は全置換を送らず、失敗応答後も置換を自動再送しない', async () => {
  const gate = deferred()
  const commands = []
  const harness = createWindowHarness(async (_label, _event, command) => { commands.push(command); await gate.promise })
  harness.sendScope('capture')
  assert.equal(harness.canRun.value, false)
  harness.sendChange('replaceAll')
  gate.release()
  await harness.wait()
  assert.deepEqual(commands.map((command) => command.type), ['scope'])
  assert.equal(harness.canRun.value, false, '送信完了だけでは範囲が確定していない')
  harness.receiveSnapshot({ ...harness.initial, revision: 2, acknowledgedSequence: 1, error: '選択がありません' })
  assert.equal(harness.errorMessage.value, '選択がありません')
  assert.equal(commands.length, 1)
  harness.sendScope('capture')
  gate.release()
  await harness.wait()
  harness.receiveSnapshot({ ...harness.initial, revision: 3, acknowledgedSequence: 2,
    scope: { ...harness.initial.scope, enabled: true, startLine: 2, endLine: 2 } })
  assert.equal(harness.canRun.value, true)
  harness.sendChange('replaceAll')
  await harness.wait()
  assert.equal(commands.at(-1).action, 'replaceAll')
})

test('範囲指定の送信失敗後は新しい連番で再試行でき、古い通知で操作を再開しない', async () => {
  const commands = []
  const harness = createWindowHarness(async (_label, _event, command) => {
    commands.push(command)
    if (commands.length === 1) throw new Error('通信失敗')
  })
  harness.sendScope('capture')
  await harness.wait()
  assert.match(harness.errorMessage.value, /通信失敗/)
  assert.equal(harness.scopeDisabled.value, false)
  harness.sendScope('capture')
  await harness.wait()
  assert.deepEqual(commands.map((command) => command.sequence), [1, 2])
  harness.receiveSnapshot({ ...harness.initial, revision: 2, acknowledgedSequence: 1 })
  assert.equal(harness.canRun.value, false)
  harness.sendChange('replaceAll')
  await harness.wait()
  assert.equal(commands.length, 2)
})
