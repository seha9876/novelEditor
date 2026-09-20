/** 配布対象の JavaScript 依存関係から、第三者ライセンス通知を生成する。 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'

const projectDirectory = process.cwd()
const outputPath = join(projectDirectory, 'THIRD_PARTY_NOTICES_JS.md')
const noticeFileName = /^(license|licence|notice|copying|copyright)([._-].*)?$/i

/** JSON ファイルを UTF-8 で読み込む。 */
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

/** pnpm の実体ディレクトリを考慮し、依存先の package.json を探す。 */
function resolveManifest(packageName, fromDirectory) {
  let directory = fromDirectory

  while (true) {
    const modulesDirectory = basename(directory) === 'node_modules'
      ? directory
      : join(directory, 'node_modules')
    const manifestPath = join(modulesDirectory, packageName, 'package.json')
    if (existsSync(manifestPath)) return realpathSync(manifestPath)

    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

/** ライセンス本文と配布時の通知を含むファイルを収集する。 */
function findNoticeFiles(packageDirectory) {
  return readdirSync(packageDirectory)
    .filter((name) => noticeFileName.test(name))
    .map((name) => join(packageDirectory, name))
    .filter((filePath) => statSync(filePath).isFile())
    .sort()
}

/** 配布物に使う本番依存関係を再帰的に収集する。 */
function collectPackages() {
  const rootManifest = readJson(join(projectDirectory, 'package.json'))
  const pending = Object.keys(rootManifest.dependencies ?? {}).map((name) => ({
    name,
    fromDirectory: projectDirectory,
    optional: false,
  }))
  const packages = new Map()

  while (pending.length > 0) {
    const dependency = pending.shift()
    const manifestPath = resolveManifest(dependency.name, dependency.fromDirectory)
    if (!manifestPath) {
      if (dependency.optional) continue
      throw new Error(`${dependency.name} の package.json が見つかりません。`)
    }

    const manifest = readJson(manifestPath)
    const identifier = `${manifest.name}@${manifest.version}`
    if (packages.has(identifier)) continue

    const noticeFiles = findNoticeFiles(dirname(manifestPath))
    const licenseFiles = noticeFiles.filter((filePath) => /^(license|licence|copying)([._-].*)?$/i.test(basename(filePath)))
    if (!manifest.license || licenseFiles.length === 0) {
      throw new Error(`${identifier} のライセンス情報を確認できません。手動で確認してください。`)
    }

    packages.set(identifier, {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      files: noticeFiles,
    })

    const optionalDependencies = manifest.optionalDependencies ?? {}
    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(optionalDependencies),
    ])
    for (const name of names) {
      pending.push({
        name,
        fromDirectory: dirname(manifestPath),
        optional: name in optionalDependencies,
      })
    }
  }

  return [...packages.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en'),
  )
}

/** 通知ファイルをパッケージごとにまとめ、改行を統一する。 */
function formatNotices(packages) {
  const sections = packages.map((packageInfo) => {
    const files = packageInfo.files.map((filePath) => {
      const content = readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n').trimEnd()
      return `### ${basename(filePath)}\n\n\`\`\`text\n${content}\n\`\`\``
    })
    return `## ${packageInfo.name}@${packageInfo.version}\n\nライセンス: ${packageInfo.license}\n\n${files.join('\n\n')}`
  })

  return [
    '# JavaScript 第三者ライセンス通知',
    '',
    'このファイルは `pnpm notices` で生成されます。配布対象の本番依存関係について、各パッケージに含まれるライセンス本文と通知を収録しています。',
    '',
    ...sections,
    '',
  ].join('\n')
}

/** 現在インストールされている本番依存関係の通知を書き出す。 */
function main() {
  writeFileSync(outputPath, formatNotices(collectPackages()), 'utf8')
}

main()
