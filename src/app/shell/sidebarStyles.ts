/** Shared look of every sidebar row: 28px tall, the 16px icon column at the same x in both widths. */
export const sidebarItemClass = [
  'group/item relative flex h-7 shrink-0 items-center gap-2 rounded-md px-2.5 text-ui font-medium',
  'text-fg-secondary transition-colors duration-fast hover:bg-hover hover:text-fg hover:duration-instant',
  'aria-[current=page]:bg-active aria-[current=page]:text-fg',
].join(' ')

/** 16px row icon: tertiary at rest, brighter on hover, primary when current. */
export const sidebarIconClass =
  'size-4 shrink-0 text-fg-tertiary group-hover/item:text-fg-secondary group-aria-[current=page]/item:text-fg'
