/** 履歴管理の判定値を、操作の意味と次の行動が分かる説明へ変換する。 */
import type { GitBackupState, GitFailure, GitRecordBlock, GitStatus } from './gitHistory'
import type { ExternalFileState } from './externalFile'

export type GitTone = 'info' | 'success' | 'warning' | 'error'
export type GitRecordMembership = 'outside' | 'noHistory' | 'checking' | 'present' | 'absent' | 'unknown'
export type GitNextTarget = 'editor' | 'record' | 'history' | 'backup' | 'refresh' | 'details' | null
export type GitStateItem = { title: string; message: string; detail: string; tone: GitTone | 'neutral'; icon: string }
export type GitNextStep = { message: string; action: string; target: GitNextTarget; tone: GitTone | 'neutral' }
type OverviewInput = {
  path: string | null; dirty: boolean; inside: boolean; currentChanged: boolean; externalState: ExternalFileState
  membership: GitRecordMembership; status: GitStatus | null; statusFailed: boolean
  listReady: boolean; listFailed: boolean; version: string | null; historyFailed: boolean
  pending: boolean; pendingLabel: string; needsAttention: boolean
}
const stateIcons = { neutral: 'mdi-minus-circle-outline', info: 'mdi-help-circle-outline', success: 'mdi-check-circle-outline', warning: 'mdi-alert-outline', error: 'mdi-alert-circle-outline' }

/** 状態の意味を文章とアイコンで揃え、色だけに判断を依存させない。 */
function stateItem(title: string, message: string, detail: string, tone: GitStateItem['tone']): GitStateItem {
  return { title, message, detail, tone, icon: stateIcons[tone] }
}

/** 現在の本文だけを扱い、対象外や外部更新を「保存済み」の正常状態に見せない。 */
function describeCurrentManuscript(input: OverviewInput): GitStateItem {
  const name = input.path?.split(/[\\/]/).pop() || '無題'
  if (!input.inside) return stateItem('現在の原稿', `${name} · このフォルダーの履歴対象外`, input.dirty ? '今の編集はまだ保存されていません。執筆画面で保存先を確認してください。' : 'この原稿の履歴・バックアップは、ここでは確認していません。', 'neutral')
  const externalMessages: Record<Exclude<ExternalFileState, 'unchanged'>, string> = {
    changed: '別の場所でファイルが変更されています。', missing: '原稿ファイルが見つかりません。', error: '原稿ファイルの状態を確認できません。',
  }
  if (input.externalState !== 'unchanged') return stateItem('現在の原稿', name, `${externalMessages[input.externalState]}本文は保持しています。執筆画面で確認してください。`, input.externalState === 'error' ? 'error' : 'warning')
  let detail = input.dirty ? '今の編集は未保存です。履歴やバックアップには含まれません。' : 'アプリ上の本文は保存済みです。'
  if (input.membership === 'present') detail += input.currentChanged ? ' 最新の履歴にあるのは変更前の内容です。' : ' 最新の履歴にこの原稿があります。'
  if (input.membership === 'absent' || input.membership === 'noHistory') detail += ' 最新の履歴にこの原稿はありません。'
  if (input.membership === 'checking') detail += ' 履歴への収録を確認中です。'
  if (input.membership === 'unknown') detail += ' 最新の履歴に含まれるかは未確認です。'
  const tone = input.membership === 'unknown' ? input.version || input.statusFailed || input.listFailed ? 'error' : 'info'
    : input.dirty || input.currentChanged || input.membership === 'absent' || input.membership === 'noHistory' ? 'warning' : input.membership === 'checking' ? 'info' : 'success'
  return stateItem('現在の原稿', name, detail, tone)
}

/** 履歴の有無と未記録変更を分け、変更0件を履歴保存済みと同一視しない。 */
function describeLocalHistory(input: OverviewInput): GitStateItem {
  if (!input.status) return stateItem('このPCの履歴', input.statusFailed || input.listFailed ? '状態を確認できません' : input.listReady && !input.version ? '履歴機能の準備が必要です' : '状態を確認中です', '確認できるまで記録操作は行いません。', input.statusFailed || input.listFailed ? 'error' : 'info')
  const count = input.status.changes.length
  const message = input.status.head ? '履歴が残っています' : 'まだ一度も記録していません'
  const detail = count ? `記録対象の保存済み原稿: ${count}件の変更が未記録です。` : '記録対象の保存済み原稿: 未記録の変更0件。'
  return stateItem('このPCの履歴', message, detail, count || !input.status.head || input.status.blocked ? 'warning' : 'success')
}

/** バックアップは記録に対する確認結果だけを表示し、未保存の本文まで保証しない。 */
function describeBackup(input: OverviewInput): GitStateItem {
  if (!input.status) return stateItem('別の保存先のバックアップ', input.statusFailed || input.listFailed ? '状態は未確認です' : input.listReady && !input.version ? '履歴機能の準備が必要です' : '状態を確認中です', '', input.statusFailed || input.listFailed ? 'error' : 'info')
  const state = input.status.backupState
  const detail = state === 'current' && (input.dirty && input.inside || input.status.changes.length)
    ? '未保存・未記録の変更は含まれていません。'
    : state === 'notSet' ? 'このPCを失った場合に備え、別ドライブへの保存をおすすめします。'
    : state === 'different' ? '未送信か、保管先の履歴が異なる可能性があります。'
    : state === 'unknown' ? 'ドライブの接続やアクセス権を確認してください。' : ''
  return stateItem('別の保存先のバックアップ', backupLabels[state], detail, state === 'current' ? 'success' : state === 'unknown' ? 'error' : 'warning')
}

/** 次の一手を優先順で案内する。誘導は画面移動であり、記録や送信の依頼ではない。 */
function suggestNextStep(input: OverviewInput): GitNextStep {
  if (input.pending) return { message: `${input.pendingLabel}… 完了までお待ちください。`, action: '', target: null, tone: 'info' }
  if (input.listFailed || input.statusFailed) return { message: '状態を確認できていません。フォルダーへのアクセスを確認して読み直してください。', action: '再確認', target: 'refresh', tone: 'error' }
  if (!input.version) return { message: '履歴機能の準備を終えてから、もう一度確認してください。', action: 'もう一度確認', target: 'refresh', tone: 'info' }
  if (input.membership === 'unknown') return { message: '現在の原稿が最新の履歴に含まれるかを確認できませんでした。', action: '再確認', target: 'refresh', tone: 'error' }
  if (input.historyFailed) return { message: '過去の原稿の一覧を読み直してください。', action: '再確認', target: 'refresh', tone: 'error' }
  if (input.needsAttention) return { message: '直前の処理で注意が必要です。上の結果と詳しい理由を確認してから再確認してください。', action: '再確認', target: 'refresh', tone: 'warning' }
  if (input.inside && input.externalState !== 'unchanged') return { message: '現在の原稿に確認が必要です。執筆画面へ戻り、外部更新の通知から対応を選んでください。', action: '執筆画面へ戻る', target: 'editor', tone: 'warning' }
  if (input.inside && input.dirty) return { message: '今の本文を履歴にも残すには、まず原稿ファイルへ保存してください。記録前の確認でも「保存して続ける」を選べます。', action: '執筆画面へ戻る', target: 'editor', tone: 'warning' }
  if (!input.status) return { message: '状態の確認を終えてから操作できます。', action: '再確認', target: 'refresh', tone: 'info' }
  if (input.status.blocked) return { message: '別の履歴処理の状態を確認する必要があります。詳しい理由は記録ボタンの近くで確認できます。', action: '記録できない理由を見る', target: 'record', tone: 'warning' }
  if (input.status.changes.length) return { message: '保存済みの変更を過去の状態として残せます。記録する原稿を確認してください。', action: '記録する原稿を確認', target: 'record', tone: 'warning' }
  if (!input.status.head) return { message: 'まだ履歴がなく、記録できる変更もありません。原稿を保存後に再確認してください。対象に出ない原稿は対応範囲を確認できます。', action: '執筆画面へ戻る', target: 'editor', tone: 'warning' }
  if (input.membership === 'absent') return { message: '現在の原稿は最新の履歴にありません。除外設定など、記録対象の範囲を確認してください。', action: '対応範囲を見る', target: 'details', tone: 'warning' }
  if (input.status.backupState === 'notSet') return { message: 'このPCの履歴を別の場所にも残すには、バックアップ先を設定してください。', action: 'バックアップの設定へ', target: 'backup', tone: 'warning' }
  if (input.status.backupState === 'unknown') return { message: 'バックアップ先を接続し、アクセスできることを確認してから再確認してください。', action: '再確認', target: 'refresh', tone: 'error' }
  if (input.status.backupState === 'different') return { message: 'バックアップする内容と保存先を確認してください。既存の履歴を強制的に上書きすることはありません。', action: 'バックアップを確認', target: 'backup', tone: 'warning' }
  return { message: '確認した範囲では追加の記録・バックアップ操作は不要です。過去の原稿を確認できます。', action: '過去の原稿を見る', target: 'history', tone: 'neutral' }
}

/** 独立した3段階の状態と次の操作をまとめ、画面側の文言による条件分岐を避ける。 */
export function describeGitOverview(input: OverviewInput) {
  return { states: [describeCurrentManuscript(input), describeLocalHistory(input), describeBackup(input)], next: suggestNextStep(input) }
}

export type GitOperation = 'check' | 'register' | 'remove' | 'record' | 'save' | 'history' | 'preview' | 'export' | 'setBackup' | 'backup' | 'restoreSource' | 'restoreDestination' | 'restore'
export const operationLabels: Record<GitOperation, string> = {
  check: '状態を確認中', register: '原稿フォルダーを登録中', remove: '登録を解除中', record: '履歴を記録中',
  save: '本文を保存中', history: '過去の記録を読み込み中', preview: '過去の原稿を読み込み中', export: '別のファイルとして取り出し中',
  setBackup: 'バックアップ先を設定中', backup: '記録をバックアップ中', restoreSource: '復元できる履歴を確認中',
  restoreDestination: '復元先を選択中', restore: '新しいフォルダーへ復元中',
}
export const backupLabels: Record<GitBackupState, string> = {
  notSet: 'バックアップ先は未設定です', noHistory: 'まだバックアップする記録がありません',
  current: '最新の記録はバックアップ済みです', different: '最新の記録とバックアップ先の履歴が一致していません',
  unknown: 'バックアップ先を確認できません',
}
export const recordBlockLabels: Record<GitRecordBlock, string> = {
  detached: 'このフォルダーの記録先が選択されていません。既存のGitツールでブランチへ戻してから「再確認」を押してください。',
  busy: '別の履歴処理が進行中です。完了してから「再確認」を押してください。ロックファイルは削除しないでください。',
  stagedOrConflict: '別のツールで記録を準備中、または変更が競合しています。既存のGitツールで処理を完了してから「再確認」を押してください。この画面からは変更を取り消しません。',
}

/** 日本語の日付で記録を区別できるようにし、解釈不能な値は省略しない。 */
export function formatGitDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP')
}

/** 検証済みの通信エラーだけを分類し、未知の例外も詳細を失わず表示する。 */
export function describeGitFailure(reason: unknown, operation: GitOperation) {
  const failure = typeof reason === 'object' && reason !== null && 'kind' in reason && 'details' in reason
    ? reason as GitFailure : null
  const details = failure?.details ?? String(reason)
  const output = failure?.output ?? ''
  if (failure?.kind === 'recordedNeedsAttention') return { message: '履歴は記録されましたが、後処理を完了できませんでした。', action: '続けて記録せず、再確認してください。解消しない場合は詳しい情報を確認できる人に相談してください。', details, output, outputIsRecord: true, tone: 'warning' as const }
  if (failure?.kind === 'restoredRegistrationFailed') return { message: 'フォルダーの復元は完了しましたが、この一覧へ登録できませんでした。', action: '再度復元せず、下のフォルダーを「原稿フォルダーを追加」から登録してください。', details, output, outputIsRecord: false, tone: 'warning' as const }
  if (failure?.kind === 'outputIncomplete') return { message: '出力を最後まで完了できませんでした。', action: '出力先に不完全なファイルやフォルダーが残っている可能性があります。出力先を確認し、別の名前を選んでください。既存の原稿への上書きは行いません。', details, output, outputIsRecord: false, tone: 'warning' as const }
  const messages: Record<GitOperation, string> = {
    check: '現在の状態を確認できませんでした。', register: '原稿フォルダーを登録できませんでした。', remove: '登録を解除できませんでした。',
    record: '履歴の記録を最後まで確認できませんでした。', save: '本文の保存が完了していないため、履歴は記録していません。',
    history: '過去の記録を読み込めませんでした。', preview: '過去の原稿を読み込めませんでした。', export: '原稿を取り出せませんでした。',
    setBackup: 'バックアップ先を設定できませんでした。', backup: 'バックアップの完了を確認できませんでした。',
    restoreSource: 'この保管先から復元できる履歴を確認できませんでした。', restoreDestination: '復元先を選択できませんでした。', restore: '復元の完了を確認できませんでした。',
  }
  const action = operation === 'backup' || operation === 'setBackup'
    ? 'ドライブの接続とアクセス権を確認し、再確認してください。履歴が異なる場合は強制的に送らず、別の空フォルダーをバックアップ先にできます。'
    : operation === 'export' ? '新しいファイル名と保存先のアクセス権を確認し、もう一度取り出してください。'
    : operation === 'save' ? '通常の保存や外部更新の確認を終えてから、変更一覧を再確認してください。'
    : 'フォルダーや他のツールの処理状況を確認して「再確認」を押してください。詳しい理由は下の詳細で確認できます。'
  return { message: messages[operation], action, details, output, outputIsRecord: false, tone: 'error' as const }
}
