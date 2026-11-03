/**
 * Shared class recipes so every floating surface, menu item and overlay looks and moves the
 * same. Durations/easings come from the motion tokens (duration-fast/base/slow, ease-*).
 */

/** Hover background appears instantly and fades out over --duration-fast (design §3.7). */
export const hoverFade = 'transition-colors duration-fast hover:duration-instant'

/** Popover / menu / select surface. */
export const floatingSurface =
  'z-(--z-dropdown) overflow-hidden rounded-lg border border-default bg-elevated text-fg shadow-popover outline-none'

/** Enter/exit motion for Radix floating content (uses data-state / data-side). */
export const floatingMotion = [
  'origin-(--radix-popper-transform-origin)',
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]',
  'data-[state=open]:duration-base data-[state=open]:ease-enter',
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98]',
  'data-[state=closed]:duration-fast data-[state=closed]:ease-exit',
  'data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1',
  'data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1',
].join(' ')

/**
 * One row in a menu / select / listbox (32px, icon + label + optional trailing hint). Leading
 * icons are tertiary, except in a destructive item (data-variant) where they keep the danger
 * colour. Keyboard users also get an inset focus ring on the highlighted row (src/index.css).
 */
export const menuItem = [
  'relative flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-ui text-fg outline-none select-none',
  'data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:text-fg-disabled',
  '[&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  '[&:not([data-variant=destructive])>svg:not([class*=text-])]:text-fg-tertiary',
].join(' ')

/** Small uppercase-free section heading inside menus. */
export const menuLabel = 'flex h-7 items-center px-2 text-meta font-semibold text-fg-tertiary'

/** Hairline separator inside menus. */
export const menuSeparator = '-mx-1 my-1 h-px bg-subtle'

/** Full-screen dim layer behind dialogs (no blur, per design §6.14). */
export const overlayClass = [
  'fixed inset-0 z-(--z-overlay) bg-overlay',
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-base',
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-fast',
].join(' ')

/** Dialog panel motion: fade + scale .98 + 4px rise in; quicker fade out. */
export const dialogMotion = [
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]',
  'data-[state=open]:slide-in-from-bottom-[4px] data-[state=open]:duration-slow data-[state=open]:ease-enter',
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98]',
  'data-[state=closed]:duration-fast data-[state=closed]:ease-exit',
].join(' ')

/** Inset focus ring for controls inside clipping containers (rows, cards, sidebar). */
export const insetFocus = 'focus-visible:outline-offset-[-2px]'

/** Pill tab / segment (28px). Active state via data-state=active|on or aria-current. */
export const pillTab = [
  'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-ui font-medium whitespace-nowrap text-fg-secondary select-none',
  'transition-colors duration-fast hover:bg-hover hover:text-fg hover:duration-instant',
  'data-[state=active]:bg-active data-[state=active]:text-fg data-[state=on]:bg-active data-[state=on]:text-fg',
  'aria-[current=page]:bg-active aria-[current=page]:text-fg',
  'disabled:pointer-events-none disabled:text-fg-disabled',
  "[&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
].join(' ')

/** Text-field look shared by Input, Textarea, Select trigger and field-style pickers. */
export const fieldBase = [
  'w-full min-w-0 rounded-md border border-input bg-surface px-2.5 text-ui text-fg',
  'transition-[border-color,background-color] duration-fast hover:border-strong',
  'focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-focus',
  'aria-invalid:border-danger aria-invalid:focus-visible:outline-danger',
  'disabled:cursor-not-allowed disabled:border-default disabled:bg-muted disabled:text-fg-disabled',
].join(' ')
