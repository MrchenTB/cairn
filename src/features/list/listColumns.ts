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
