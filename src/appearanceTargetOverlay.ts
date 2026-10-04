/** 既存要素を変更せず、クリックを透過する装飾で配色の代表箇所を示す。 */
import { colorDefinitions, type ColorKey } from './appearance'
import { colorTargets } from './appearanceTargets'
import { createFrameTask } from './frameTask'

export type TargetRectangle = { left: number; top: number; width: number; height: number }

/** 画面外とスクロール領域の外を切り落とし、隠れた要素を強調しない。 */
export function getVisibleTargetRectangle(element: HTMLElement): TargetRectangle | null {
  if (element.closest('[hidden], [inert], .appearance-preview, .appearance-target-overlay')) return null
  let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight
  const rectangle = element.getBoundingClientRect()
  left = Math.max(left, rectangle.left); top = Math.max(top, rectangle.top)
  right = Math.min(right, rectangle.right); bottom = Math.min(bottom, rectangle.bottom)
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return null
    if (parent === element) continue
    const bounds = parent.getBoundingClientRect()
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right) }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom) }
  }
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null
}

/** 強調中だけ位置とDOMを監視し、本文・フォーカス・設定値には触れない。 */
export function createAppearanceTargetOverlay() {
  let key: ColorKey | null = null
  let layer: HTMLDivElement | null = null
  let mutation: MutationObserver | null = null
  let resize: ResizeObserver | null = null
  let observed: HTMLElement[] = []
  let disposed = false
  const frame = createFrameTask(render)

  /** 見えている代表箇所を最大6個示し、長文の文字ごとに装飾を生成しない。 */
  function render(): void {
    if (!key || !layer || disposed) return
    let candidates = [...document.querySelectorAll<HTMLElement>(colorTargets[key].selectors)]
    if (key === 'selectionText' && !document.querySelector('.editor-host .cm-selectionBackground')) candidates = []
    const targets = candidates.filter(element => !element.closest('.color-setting-row'))
      .map(element => ({ element, rectangle: getVisibleTargetRectangle(element) }))
      .filter(target => target.rectangle !== null)
      // 親領域を囲めば内側も示せるため、同じ場所にラベルを重ねない。
      .filter((target, index, visible) => !visible.slice(0, index).some(parent => parent.element.contains(target.element)))
      .slice(0, 6)
    const elements = targets.map(target => target.element)
    if (elements.length !== observed.length || elements.some((element, index) => element !== observed[index])) {
      resize?.disconnect()
      observed = elements
      observed.forEach(element => resize?.observe(element))
      resize?.observe(document.documentElement)
    }
    const fragment = document.createDocumentFragment()
    for (const { rectangle } of targets) {
      if (!rectangle) continue
      const marker = document.createElement('div')
      marker.className = 'appearance-target-marker'
      Object.assign(marker.style, { left: `${rectangle.left}px`, top: `${rectangle.top}px`, width: `${rectangle.width}px`, height: `${rectangle.height}px` })
      const label = document.createElement('span')
      label.className = 'appearance-target-label'
      label.textContent = `${colorDefinitions[key][0]} · ${colorDefinitions[key][1]}（${colorTargets[key].kind}）`
      // カーソルや下端のバーでもラベルが画面外へ出ないよう、枠との指示線を添える。
      const labelLeft = Math.max(8, Math.min(rectangle.left + 10, window.innerWidth - 352)) - rectangle.left
      const labelTop = Math.max(8, Math.min(rectangle.top + 10, window.innerHeight - 72)) - rectangle.top
      Object.assign(label.style, { left: `${labelLeft}px`, top: `${labelTop}px` })
      const pointer = document.createElement('div')
      pointer.className = 'appearance-target-pointer'
      Object.assign(pointer.style, { width: `${Math.hypot(labelLeft, labelTop)}px`, transform: `rotate(${Math.atan2(labelTop, labelLeft)}rad)` })
      marker.append(pointer, label)
      fragment.append(marker)
    }
    layer.replaceChildren(fragment)
  }

  /** スクロールやレイアウト変化を同じ描画フレームへ集約する。 */
  function schedule(): void { frame.schedule() }

  /** DOM装飾と監視を残さず解除する。 */
  function clear(): void {
    frame.cancel()
    mutation?.disconnect(); mutation = null
    resize?.disconnect(); resize = null; observed = []
    window.removeEventListener('scroll', schedule, true)
    window.removeEventListener('resize', schedule)
    layer?.remove(); layer = null
  }

  /** 新しい対象のときだけ装飾層を作り、領域の色や寸法は書き換えない。 */
  function update(next: ColorKey | null): void {
    if (disposed || key === next) return
    clear(); key = next
    if (!key) return
    layer = document.createElement('div')
    layer.className = 'appearance-target-overlay'
    layer.setAttribute('aria-hidden', 'true')
    document.body.append(layer)
    mutation = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element && record.target.closest('.appearance-target-overlay')))) schedule()
    })
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert'] })
    resize = new ResizeObserver(schedule)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    render()
  }

  /** 画面終了後の通知では装飾層を作らない。 */
  function dispose(): void { clear(); key = null; disposed = true; frame.dispose() }
  return { update, dispose }
}
