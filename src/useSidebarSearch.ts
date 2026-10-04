/** 本文・登録TXTの検索結果と、既存の読込経路を使う位置移動を管理する。 */
import { ref, watch, nextTick, type Ref } from 'vue'
import { stat } from '@tauri-apps/plugin-fs'
import { createProjectFileCandidates, type ProjectFileCandidate } from './projectFileSearch'
import { authorizeProjectFile } from './projectTreeClient'
import { loadTextFile } from './textFile'
import { sameRecentFilePath, comparablePath } from './recentFiles'
import { fingerprintBytes, type TextMatch } from './sidebarAnalysis'
import { runSidebarAnalysis } from './sidebarWorker'
import type { ProjectTreeSnapshot } from './projectTreeModel'
import type { SearchConditions } from './searchSession'
import type { DocumentEditorHandle } from './useDocumentSession'
import type { ProjectTreeOpenRequest, ProjectTreeOpenResult } from './projectTreeWindow'

export type SidebarMatch = TextMatch & { candidate: ProjectFileCandidate | null; path: string | null; revision: number; fingerprint: string; current: boolean }
type Options = { active: Readonly<Ref<boolean>>; editor: Ref<DocumentEditorHandle | null>; revision: Ref<number>; path: Readonly<Ref<string | null>>
  conditions: Ref<SearchConditions>; snapshot: Readonly<Ref<ProjectTreeSnapshot>>; disabled: Readonly<Ref<boolean>>
  openFile: (request: ProjectTreeOpenRequest) => Promise<void> }

/** 非表示・条件変更・本文変更を世代で無効化し、途中の結果を正常完了に見せない。 */
export function useSidebarSearch(options: Options) {
  const scope = ref<'document' | 'project'>('document'), results = ref<SidebarMatch[]>([]), errors = ref<string[]>([])
  const pending = ref(false), navigating = ref(false), stale = ref(false), limited = ref(false), message = ref('検索語を入力してください。')
  const shown = ref(200), selected = ref(0)
  let generation = 0, timer: ReturnType<typeof setTimeout> | undefined, abort: AbortController | null = null, disposed = false
  let openResult: ProjectTreeOpenResult | null = null, requestId: string | null = null

  /** 読込済みの応答だけを捨て、本文や許可済みファイルへ書き込まない。 */
  function cancel(): void { if (pending.value) { message.value = '検索を中止しました。再検索できます。'; stale.value = !!results.value.length }; generation++; abort?.abort(); abort = null; if (timer) clearTimeout(timer); timer = undefined; pending.value = false }

  /** 表示条件の変化を結果に明示し、古い一致位置のクリックを止める。 */
  function invalidate(): void {
    cancel(); options.editor.value?.setSidebarMatches(options.revision.value, []); stale.value = !!results.value.length; errors.value = []
    if (!options.active.value) return
    if (scope.value === 'document') { timer = setTimeout(() => { void search() }, 200) }
    else message.value = '条件・対象が変わりました。「検索」で読み直してください。'
  }

  /** 同じ実パスの複数登録を代表1件にまとめ、仮想フォルダーは走査先にしない。 */
  function projectCandidates(): ProjectFileCandidate[] {
    const candidates = createProjectFileCandidates(options.snapshot.value).filter(file => file.projectId === options.snapshot.value.activeProjectId)
    const seen = new Set<string>()
    return candidates.filter(file => { const key = comparablePath(file.path); if (seen.has(key)) return false; seen.add(key); return true })
  }

  /** 保存済みTXTだけを許可・検証して読み、更新された登録先を検索に混ぜない。 */
  async function readCandidate(candidate: ProjectFileCandidate) {
    const path = await authorizeProjectFile(candidate.nodeId)
    if (!sameRecentFilePath(path, candidate.path)) throw new Error('登録先が変更されました。再検索してください。')
    if ((await stat(path)).size > 10 * 1024 * 1024) throw new Error('10MiBを超えるため検索対象から除きました。')
    const file = await loadTextFile(path)
    if (file.originalBytes.length > 10 * 1024 * 1024) throw new Error('10MiBを超えるため検索対象から除きました。')
    return { text: file.text.replace(/\r\n|\r/g, '\n'), fingerprint: await fingerprintBytes(file.originalBytes) }
  }

  /** 本文は入力追従、複数ファイルは明示操作で解析し、読込を同時2件に制限する。 */
  async function search(): Promise<void> {
    if (disposed || !options.active.value || options.disabled.value || navigating.value) return
    cancel(); const own = generation, signal = new AbortController(); abort = signal
    const conditions = { ...options.conditions.value }, document = options.editor.value?.getDocumentSnapshot()
    results.value = []; errors.value = []; limited.value = false; stale.value = false; shown.value = 200; selected.value = 0
    if (!conditions.search) { message.value = '検索語を入力してください。'; return }
    if (!document) { message.value = '本文の準備ができていません。'; return }
    pending.value = true; message.value = '検索中です…'
    const matches: SidebarMatch[] = [], failures: string[] = []
    try {
      await runSidebarAnalysis({ kind: 'search', text: '', conditions, limit: 1, scope: null }, signal.signal)
      if (own !== generation || disposed) return
      const candidates: (ProjectFileCandidate | null)[] = scope.value === 'document' ? [null] : projectCandidates()
      if (!candidates.length) { message.value = 'このプロジェクトには検索するTXTが登録されていません。'; return }
      for (let index = 0; index < candidates.length; index += 2) {
        const batch = await Promise.allSettled(candidates.slice(index, index + 2).map(async candidate => {
          const current = !candidate || !!options.path.value && sameRecentFilePath(candidate.path, options.path.value)
          const source = current ? { text: document.text, fingerprint: '' } : await readCandidate(candidate!)
          return { candidate, current, ...source }
        }))
        if (own !== generation || disposed) return
        for (let offset = 0; offset < batch.length; offset++) {
          const result = batch[offset]!, candidate = candidates[index + offset]!
          if (result.status === 'rejected') { failures.push(`${candidate?.name || '現在の本文'}: ${String(result.reason)}`); continue }
          const source = result.value
          try {
            const parsed = await runSidebarAnalysis<{ matches: TextMatch[]; limited: boolean }>({ kind: 'search', text: source.text, conditions,
              limit: 1000 - matches.length, scope: scope.value === 'document' ? document.scope : null }, signal.signal)
            if (own !== generation || disposed) return
            matches.push(...parsed.matches.map(match => ({ ...match, candidate: source.candidate, path: source.candidate?.path ?? options.path.value,
              revision: source.current ? document.revision : -1, fingerprint: source.fingerprint, current: source.current })))
            if (parsed.limited || matches.length === 1000 && index + offset + 1 < candidates.length) { limited.value = true; break }
          } catch (error) { if (own !== generation) return; failures.push(`${candidate?.name || '現在の本文'}: ${String(error)}`) }
        }
        if (limited.value) break
      }
      if (own !== generation || disposed) return
      results.value = matches; errors.value = failures
      options.editor.value?.setSidebarMatches(document.revision, matches.filter(match => match.current))
      message.value = limited.value ? '先頭1,000件までの結果です。検索語を絞ってください。'
        : failures.length ? `${matches.length}件の一致。一部の原稿を検索できませんでした。` : matches.length ? `${matches.length}件の一致` : '該当なし'
    } catch (error) { if (own === generation && !disposed) { errors.value = [String(error)]; message.value = '検索できませんでした。条件を見直してください。' } }
    finally { if (own === generation && !disposed) pending.value = false }
  }

  /** 自分が出した読込要求の成功・取消だけを受け取り、ツリーの別操作と混同しない。 */
  function receiveOpenResult(result: ProjectTreeOpenResult): boolean {
    if (result.requestId !== requestId) return false
    openResult = result; return true
  }

  /** 同じ原稿は再生成せず、別原稿の読込成功と内容照合後だけ一致へ移動する。 */
  async function openMatch(index: number): Promise<void> {
    const match = results.value[index]
    if (!match || disposed || !options.active.value || stale.value || pending.value || navigating.value || options.disabled.value) return
    selected.value = index; navigating.value = true
    try {
      if (match.current) {
        if (!options.editor.value?.revealRange({ revision: match.revision, from: match.from, to: match.to })) throw new Error('本文が変わりました。もう一度検索してください。')
      } else {
        requestId = crypto.randomUUID(); openResult = null
        await options.openFile({ requestId, nodeId: match.candidate!.nodeId, projectId: match.candidate!.projectId, expectedPath: match.candidate!.path, searchFingerprint: match.fingerprint })
        if (disposed || !options.active.value) return
        const outcome = openResult as ProjectTreeOpenResult | null
        if (outcome?.outcome === 'cancelled') return
        if (!outcome || outcome.error || outcome.outcome !== 'opened') throw new Error(outcome?.error || '読込結果を確認できませんでした。')
        await nextTick()
        if (disposed || !options.active.value) return
        const document = options.editor.value?.getDocumentSnapshot()
        if (!document || !options.editor.value?.revealRange({ revision: document.revision, from: match.from, to: match.to })) throw new Error('本文へ移動できませんでした。')
      }
    } catch (error) { errors.value = [String(error)]; stale.value = true }
    finally { navigating.value = false; requestId = null }
  }

  /** 結果の移動だけでは原稿を開かず、Enterで明示してから本文へ移る。 */
  function moveSelection(direction: number): void { selected.value = Math.max(0, Math.min(Math.min(shown.value, results.value.length) - 1, selected.value + direction)) }
  const stops = [watch([options.conditions, options.revision, options.path, scope, options.snapshot], invalidate), watch([options.disabled, navigating], () => { if (!options.disabled.value && !navigating.value && scope.value === 'document') invalidate() }), watch(options.active, active => {
    if (!active) { cancel(); options.editor.value?.setSidebarMatches(options.revision.value, []) }
    else if (scope.value === 'document') {
      if (results.value.length && !stale.value) options.editor.value?.setSidebarMatches(options.revision.value, results.value.filter(match => match.current))
      else invalidate()
    }
  })]
  /** 終了時にタイマー・解析を解放し、後から到着するファイル読込を適用しない。 */
  function dispose(): void { disposed = true; cancel(); stops.forEach(stop => stop()) }
  return { scope, results, errors, pending, navigating, stale, limited, message, shown, selected, search, cancel, openMatch, moveSelection, receiveOpenResult, invalidate, dispose }
}
