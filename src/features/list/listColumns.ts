/**
 * Fixed widths of the List's right-hand columns — priority · start · due · ⋯ menu. Task rows,
 * milestone rows and the column header all use them, so the date columns line up and a long task
 * name only ever shortens its own column.
 */
export const listColumn = {
  priority: 'w-6',
  start: 'w-20',
  due: 'w-24',
  menu: 'w-6',
} as const

/** Height of the sticky column header; phase headers stick right below it. */
export const listHeaderHeight = 'h-7'
export const belowListHeader = 'top-7'

/**
 * Hairline under each task and milestone row, so a wide List still reads across from a title to
 * its dates. It is an inset shadow, not a border: the row stays exactly 36px, the hover background
 * fills under it, and the drop line of a drag (centred in the placeholder row) is never covered.
 */
export const rowDivider = 'shadow-[inset_0_-1px_0_var(--border-subtle)]'
