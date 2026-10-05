/** アウトラインの未完成入力・Worker判定・入力世代を設定保存から分離する。 */
import { computed, ref, watch } from 'vue'
import { cloneOutlineRules, outlineExample, outlineRuleError, outlineRulesSignature, type OutlineHeading, type OutlinePreferences, type OutlineRule } from './outline'
import { runSidebarAnalysis } from './sidebarWorker'

type OutlineDraftOptions = {
  preferences: () => OutlinePreferences
  epoch: () => number
  publish: (rules: OutlineRule[], epoch: number) => void
}

/** 判定成功時だけ現在のルールを送り、同値返信や名称変更では下書きを消さない。 */
export function useOutlineRuleDraft(options: OutlineDraftOptions) {
  const draft = ref({ rules: cloneOutlineRules(options.preferences()) })
  const example = ref(outlineExample), preview = ref<OutlineHeading[]>([])
  const previewError = ref(''), previewPending = ref(false), savePending = ref(false)
  const errors = computed(() => draft.value.rules.map(outlineRuleError))
  const submitted: string[] = []
  let generation = 0, disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: AbortController | null = null

  /** 旧ルール・旧例文の判定と予約を停止し、遅れた応答を無効化する。 */
  function cancel(): void {
    generation++; abort?.abort(); abort = null
    if (timer) clearTimeout(timer)
    timer = undefined; previewPending.value = false
  }

  /** 通信中の自分の更新を記録し、遅れて返る確認値で次の入力を消さない。 */
  function markSubmitted(rules: OutlineRule[]): void {
    const signature = outlineRulesSignature({ rules })
    if (submitted.at(-1) !== signature && (submitted.length || signature !== outlineRulesSignature(options.preferences()))) submitted.push(signature)
    savePending.value = false
  }

  /** 保存操作は未反映の下書きを取得し、自動反映とは別の一操作にまとめられる。 */
  async function validate(autoPublish = false): Promise<OutlineRule[] | null> {
    if (disposed) return null
    cancel()
    const own = generation, epoch = options.epoch()
    const rules = cloneOutlineRules(draft.value)
    previewError.value = ''; preview.value = []
    if (errors.value.some(Boolean)) { previewError.value = 'ルールの入力を完成させてください。'; return null }
    const controller = new AbortController(); abort = controller; previewPending.value = true
    try {
      const result = await runSidebarAnalysis<OutlineHeading[]>({ kind: 'outline', text: example.value.replace(/\r\n|\r/g, '\n'), preferences: { rules } }, controller.signal)
      if (disposed || own !== generation || epoch !== options.epoch()) return null
      preview.value = result
      if (autoPublish && savePending.value) {
        markSubmitted(rules)
        options.publish(rules, epoch)
      }
      return rules
    } catch (reason) {
      if (own === generation && !disposed) previewError.value = reason instanceof Error ? reason.message : String(reason)
      return null
    } finally { if (own === generation) { previewPending.value = false; abort = null } }
  }

  /** 例文だけの更新でも保存待ちを保持し、最後のルールを200ms後に確認する。 */
  function schedule(): void {
    if (disposed) return
    cancel()
    timer = setTimeout(() => { timer = undefined; void validate(true) }, 200)
  }

  /** 編集は即時保存せず、入力が完成してWorker判定が成功するまで待つ。 */
  function change(): void { savePending.value = true; schedule() }

  /** Undo・切替・復元だけで下書きを置き換え、登録一覧だけの変更は無視する。 */
  function receive(epoch: number, signature: string, previousEpoch: number, previousSignature: string): void {
    if (epoch === previousEpoch) {
      if (signature === previousSignature) return
      const index = submitted.indexOf(signature)
      if (index >= 0) { submitted.splice(0, index + 1); return }
      if (signature === outlineRulesSignature(draft.value)) return
    }
    cancel(); submitted.length = 0; savePending.value = false
    draft.value = { rules: cloneOutlineRules(options.preferences()) }
    schedule()
  }

  const stopPreferences = watch(() => [options.epoch(), outlineRulesSignature(options.preferences())] as const,
    ([epoch, signature], [previousEpoch, previousSignature]) => receive(epoch, signature, previousEpoch, previousSignature))
  const stopExample = watch(example, schedule, { immediate: true })

  /** ページ・窓の終了時には、保存前の判定と購読を残さない。 */
  function dispose(): void { disposed = true; cancel(); stopPreferences(); stopExample(); submitted.length = 0 }
  return { draft, example, preview, previewError, previewPending, savePending, errors, change, validate, markSubmitted, schedule, cancel, dispose }
}
