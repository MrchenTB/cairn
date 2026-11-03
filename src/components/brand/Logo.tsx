import { cn } from '@/lib/utils'

/**
 * Three tilted, offset stones in a 24×24 box: [cx, cy, rx, ry, rotation°]. Deliberately unlike
 * the priority glyph (straight, centred bars). Keep public/favicon.svg in sync.
 */
const STONES = [
  [12, 18.6, 10, 3.4, -4],
  [10.4, 11, 7.2, 3, 7],
  [13.4, 4.3, 4.6, 2.6, -10],
] as const

function Stones() {
  return STONES.map(([cx, cy, rx, ry, rotate]) => (
    <ellipse key={cy} cx={cx} cy={cy} rx={rx} ry={ry} transform={`rotate(${rotate} ${cx} ${cy})`} />
  ))
}

export interface LogoMarkProps {
  /** Pixel size of the square mark. */
  size?: number
  /** `mono` = stones in currentColor (sidebar, print); `brand` = stones on an accent tile. */
  tone?: 'mono' | 'brand'
  className?: string
  /** Accessible name; omit when the mark sits next to visible "Cairn" text. */
  title?: string
}

/** The Cairn mark: a small balanced stack of stones. */
export function LogoMark({ size = 20, tone = 'mono', className, title }: LogoMarkProps) {
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true as const }
  if (tone === 'brand') {
    return (
      <svg
        viewBox="0 0 32 32"
        width={size}
        height={size}
        className={cn('shrink-0', className)}
        {...a11y}
      >
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <g fill="var(--accent-fg)" transform="translate(2.4 2.6) scale(1.13)">
          <Stones />
        </g>
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={cn('shrink-0', className)}
      {...a11y}
    >
      <Stones />
    </svg>
  )
}

export interface LogoProps extends Omit<LogoMarkProps, 'title'> {
  /** Show the "Cairn" wordmark next to the mark (default true). */
  wordmark?: boolean
  wordmarkClassName?: string
}

/** Mark + wordmark. Monochrome by default so it inherits the surrounding text colour. */
export function Logo({ wordmark = true, wordmarkClassName, className, ...markProps }: LogoProps) {
  if (!wordmark) return <LogoMark title="Cairn" className={className} {...markProps} />
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark {...markProps} />
      <span
        className={cn(
          'text-[15px] leading-5 font-semibold tracking-[-0.01em] text-fg',
          wordmarkClassName,
        )}
      >
        Cairn
      </span>
    </span>
  )
}
