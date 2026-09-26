/** Writer機能スイートで共有する、ソースモジュール読込とテスト用待機点を提供する。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder, TextEncoder } from 'node:util'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** TypeScriptをメモリ上で読み込み、Tauri境界だけを差し替えて実際のアプリ処理を検証する。 */
function loadSourceModule(relativePath, mocks = {}, cache = new Map()) {
  const path = resolve(projectRoot, relativePath)
  if (cache.has(path)) return cache.get(path)
  const module = { exports: {} }
  cache.set(path, module.exports)
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const sourceRequire = (specifier) => {
    if (specifier in mocks) return mocks[specifier]
    if (specifier.startsWith('.')) return loadSourceModule(resolve(dirname(path), `${specifier}.ts`), mocks, cache)
    return require(specifier)
  }
  new Function('require', 'module', 'exports', compiled)(sourceRequire, module, module.exports)
  return module.exports
}

/** 復元Storeを固定のテスト用保存先へ接続し、Tauriの入出力だけ差し替える。 */
function loadRecoveryModule(mocks = {}) {
  const cache = new Map()
  const storageLocation = loadSourceModule('src/storageLocation.ts', mocks, cache)
  storageLocation.setActiveStorageDirectory('C:\\storage-test')
  return loadSourceModule('src/recoveryStore.ts', mocks, cache)
}

/** 非同期書き込みを任意の時点で完了させるための待機点を作る。 */
function deferred() {
  let release
  const promise = new Promise((resolvePromise) => { release = resolvePromise })
  return { promise, release }
}

export {
  assert,
  deferred,
  loadRecoveryModule,
  loadSourceModule,
  projectRoot,
  readFileSync,
  require,
  resolve,
  test,
  TextDecoder,
  TextEncoder,
  ts,
}
