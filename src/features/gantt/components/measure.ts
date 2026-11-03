/**
 * Width of a bar label (12px / 500, the UI font stack) measured once per text with a canvas, so
 * bars can decide "label inside or to the right" without reading layout. Falls back to an
 * estimate where canvas is unavailable (jsdom).
 */
const cache = new Map<string, number>()
let context: CanvasRenderingContext2D | null | undefined

function getContext(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context
  context = null
  if (typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)) return context
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx) {
      const family =
        getComputedStyle(document.documentElement).getPropertyValue('--font-family-sans').trim() ||
        'system-ui, sans-serif'
      ctx.font = `500 12px ${family}`
      context = ctx
      // Inter may still be loading: re-measure once the real font is in.
      void document.fonts?.ready.then(() => cache.clear())
    }
  } catch {
    context = null
  }
  return context
}

export function measureLabelWidth(text: string): number {
  const cached = cache.get(text)
  if (cached !== undefined) return cached
  const ctx = getContext()
  const width = ctx ? ctx.measureText(text).width : text.length * 6.6
  if (cache.size > 5000) cache.clear()
  cache.set(text, width)
  return width
}
