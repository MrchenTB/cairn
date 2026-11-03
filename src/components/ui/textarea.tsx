import { useCallback, useLayoutEffect, useMemo, useRef, type ComponentProps, type Ref } from 'react'
import { cn } from '@/lib/utils'
import { fieldBase } from './styles'

function composeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as { current: T | null }).current = node
    }
  }
}

export interface TextareaProps extends ComponentProps<'textarea'> {
  /** Grow with the content between minRows and maxRows (default true). */
  autoGrow?: boolean
  minRows?: number
  maxRows?: number
}

/** Multi-line text field that grows with its content (then scrolls past maxRows). */
export function Textarea({
  className,
  autoGrow = true,
  minRows = 3,
  maxRows = 16,
  rows,
  value,
  onInput,
  ref,
  ...props
}: TextareaProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)
  const setRef = useMemo(() => composeRefs(innerRef, ref), [ref])

  const resize = useCallback(() => {
    const el = innerRef.current
    if (!el || !autoGrow) return
    const style = window.getComputedStyle(el)
    const lineHeight = Number.parseFloat(style.lineHeight) || 20
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
    const border =
      Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
    const min = minRows * lineHeight + padding + border
    const max = maxRows * lineHeight + padding + border
    el.style.height = 'auto'
    const content = el.scrollHeight + border
    el.style.height = `${Math.min(Math.max(content, min), max)}px`
    el.style.overflowY = content > max ? 'auto' : 'hidden'
  }, [autoGrow, minRows, maxRows])

  useLayoutEffect(() => {
    resize()
  }, [resize, value])

  // Re-measure when the width changes (line wrapping changes).
  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el || !autoGrow || typeof ResizeObserver === 'undefined') return undefined
    let lastWidth = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth
        resize()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [autoGrow, resize])

  const handleInput: NonNullable<ComponentProps<'textarea'>['onInput']> = (event) => {
    onInput?.(event)
    resize()
  }

  return (
    <textarea
      ref={setRef}
      data-slot="textarea"
      rows={rows ?? minRows}
      value={value}
      onInput={handleInput}
      className={cn(fieldBase, 'block resize-none py-1.5 leading-(--line-height-ui)', className)}
      {...props}
    />
  )
}
