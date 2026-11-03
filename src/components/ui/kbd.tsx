import { Fragment, type ComponentProps } from 'react'
import { formatHotkey, hotkeyLabel } from '@/lib/keyboard'
import { cn } from '@/lib/utils'

export interface KbdProps extends ComponentProps<'kbd'> {
  /** `inverse` for use inside tooltips (dark-on-light / light-on-dark surfaces). */
  variant?: 'default' | 'inverse'
}

/**
 * One key cap: 18px tall, 11px, muted surface. Uses the UI sans (not mono) so letter keys stay
 * unambiguous at this size (O vs 0).
 */
export function Kbd({ className, variant = 'default', ...props }: KbdProps) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border px-1',
        'font-sans text-micro font-medium tabular-nums',
        variant === 'inverse'
          ? 'border-fg-inverse/25 bg-fg-inverse/10 text-fg-inverse/80'
          : 'border-default bg-muted text-fg-tertiary',
        className,
      )}
      {...props}
    />
  )
}

export interface ShortcutProps {
  /** Binding in the keyboard engine syntax: 'mod+k', 'g o', '?'. */
  keys: string
  variant?: KbdProps['variant']
  className?: string
}

/** Renders a binding as key caps ('mod+k' → ⌘ K; 'g o' → G then O) with a text label for AT. */
export function Shortcut({ keys, variant, className }: ShortcutProps) {
  const chords = formatHotkey(keys)
  return (
    <span
      className={cn('inline-flex items-center gap-0.5', className)}
      aria-label={hotkeyLabel(keys)}
      role="img"
    >
      {chords.map((chord, chordIndex) => (
        <Fragment key={chordIndex}>
          {chordIndex > 0 ? (
            <span
              aria-hidden
              className={cn(
                'px-0.5 text-micro',
                variant === 'inverse' ? 'text-fg-inverse/70' : 'text-fg-tertiary',
              )}
            >
              then
            </span>
          ) : null}
          {chord.map((key, keyIndex) => (
            <Kbd key={keyIndex} variant={variant} aria-hidden>
              {key}
            </Kbd>
          ))}
        </Fragment>
      ))}
    </span>
  )
}
