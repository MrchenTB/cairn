/**
 * Default colour for a new phase: spread phases over the palette so they are easy to tell apart.
 * Pure; used by the UI entries that create phases (the dialog and the List's inline add), which
 * pass the result explicitly. The data layer still treats an omitted or null colour as "use the
 * project's".
 */
import {
  PHASE_COLORS,
  resolvePhaseColor,
  type Phase,
  type PhaseColor,
  type ProjectColor,
} from './types'

/** Tie-break order: palette order with gray last, like the project colour suggestion. */
const CANDIDATES: readonly PhaseColor[] = [
  ...PHASE_COLORS.filter((color) => color !== 'gray'),
  'gray',
]

/**
 * The colour for the next phase of a project, which is appended after `phases` (any order):
 * the least used colour as the phases are displayed (a phase without its own colour counts as the
 * project's), never the colour of the last phase, ties broken by `CANDIDATES`. No randomness.
 */
export function suggestPhaseColor(
  phases: readonly Pick<Phase, 'color' | 'sortOrder'>[],
  projectColor: ProjectColor,
): PhaseColor {
  const usage = new Map<ProjectColor, number>()
  let lastKey: string | null = null
  for (const phase of phases) {
    const shown = resolvePhaseColor(phase.color, projectColor)
    usage.set(shown, (usage.get(shown) ?? 0) + 1)
    if (lastKey === null || phase.sortOrder > lastKey) lastKey = phase.sortOrder
  }
  // Every phase sharing the highest key counts as last, so the result does not depend on the order
  // of `phases` when keys are duplicated.
  const previous = new Set<ProjectColor>()
  for (const phase of phases) {
    if (phase.sortOrder === lastKey) previous.add(resolvePhaseColor(phase.color, projectColor))
  }
  const allowed = CANDIDATES.filter((color) => !previous.has(color))
  let best = allowed[0] ?? CANDIDATES[0]
  for (const color of allowed) {
    if ((usage.get(color) ?? 0) < (usage.get(best) ?? 0)) best = color
  }
  return best
}
