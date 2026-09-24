// TXT の入出力と、CodeMirror 内部の本文から元のバイト表現への変換を担当する。
import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'

export type LineEnding = '\n' | '\r\n' | '\r'

export interface TextFile {
  path: string
  text: string
  lineEnding: LineEnding
  hasBom: boolean
  // 未編集での再保存時に、混在改行を含む元の表現を失わないため保持する。
  originalBytes: Uint8Array
  // CodeMirror に読み込ませた後の本文。元バイト列を再利用できるかの判定に使う。
  editorText?: string
}

const txtFilter = [{ name: 'テキストファイル', extensions: ['txt'] }]

/** Tauri のダイアログで開く TXT を選ぶ。選択パスは fs の許可範囲に加わり、取消時は null。 */
export async function chooseTextFile(): Promise<string | null> {
  return open({ multiple: false, directory: false, filters: txtFilter })
}

/** 初期ファイル名を示して保存先を選ぶ。選択パスは fs の許可範囲に加わり、取消時は null。 */
export async function chooseSavePath(defaultPath: string): Promise<string | null> {
  return save({ defaultPath, filters: txtFilter })
}

/** 指定パスの TXT をバイト列で読み、元の BOM と改行情報を含む文書へ変換する。 */
export async function loadTextFile(path: string): Promise<TextFile> {
  const bytes = await readFile(path)
  return decodeTextFile(path, bytes)
}

/** 読み込んだバイト列を UTF-8 の文書へ変換する。不正な UTF-8 は上書きによる破損を避けるため例外にする。 */
export function decodeTextFile(path: string, bytes: Uint8Array): TextFile {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  // 読めないバイトを置換文字へ黙って変えると、そのまま上書きした際に原文が失われる。
  const text = new TextDecoder('utf-8', { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes)
  // 混在した改行を編集した場合は、最初に現れた形式を保存時の基準とする。
  const firstBreak = text.match(/\r\n|\r|\n/)
  const lineEnding = (firstBreak?.[0] ?? '\n') as LineEnding
  return { path, text, lineEnding, hasBom, originalBytes: bytes }
}

/**
 * 本文を指定パスへ保存する。改行形式と BOM は読み込み元に合わせる。
 * 未編集文書なら別名保存でも元のバイト列を使い、混在改行も維持する。
 * 成功したバイト列を返すので、以降の保存はこの結果を新しい基準にする。
 */
export async function saveTextFile(
  path: string,
  text: string,
  lineEnding: LineEnding,
  hasBom: boolean,
  original?: TextFile,
): Promise<TextFile> {
  // CodeMirror は混在した改行を保持できないため、未編集なら元のバイト列をそのまま保存する。
  const bytes = original?.editorText === text
    ? original.originalBytes
    : encodeTextFile(text, lineEnding, hasBom)
  await writeFile(path, bytes)
  return { path, text, lineEnding, hasBom, originalBytes: bytes, editorText: text }
}

/** 本文を指定の改行形式と BOM を持つ UTF-8 バイト列へ変換する。ファイルへの書き込みは行わない。 */
export function encodeTextFile(text: string, lineEnding: LineEnding, hasBom: boolean): Uint8Array {
  const normalized = text.replace(/\r\n|\r|\n/g, lineEnding)
  const content = new TextEncoder().encode(normalized)
  if (!hasBom) return content
  const bytes = new Uint8Array(content.length + 3)
  bytes.set([0xef, 0xbb, 0xbf])
  bytes.set(content, 3)
  return bytes
}

/** Windows とその他のパス区切りに対応して、表示用のファイル名を取り出す。 */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}
