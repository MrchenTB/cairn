import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge taught the design-system scales from src/index.css. Without this it treats
 * e.g. `text-heading` (a font size) as a text colour and drops it next to `text-fg`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['micro', 'meta', 'ui', 'body', 'heading', 'title', 'display'],
      shadow: ['panel', 'popover', 'modal', 'drag'],
      ease: ['enter', 'exit', 'move'],
      animate: ['breathe', 'fade-in-delayed'],
    },
    classGroups: {
      duration: [{ duration: ['instant', 'fast', 'base', 'slow'] }],
    },
  },
})

/** Merge Tailwind class names (shadcn convention). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
