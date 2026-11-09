import { describe, expect, it } from 'vitest'
import { suggestPhaseColor } from './phaseColors'
import type { PhaseColor, ProjectColor } from './types'

type P = { color: PhaseColor | null; sortOrder: string }

const ORDER: PhaseColor[] = ['blue', 'violet', 'pink', 'orange', 'yellow', 'green', 'teal', 'gray']

/** sortOrder keys that sort in creation order. */
const key = (index: number) => `a${String(index).padStart(3, '0')}`

/** Append `count` phases one at a time, each with the colour suggested for it. */
function append(count: number, projectColor: ProjectColor = 'red', start: P[] = []): P[] {
  const phases = [...start]
  for (let i = 0; i < count; i++) {
    phases.push({
      color: suggestPhaseColor(phases, projectColor),
      sortOrder: key(phases.length),
    })
  }
  return phases
}

describe('suggestPhaseColor', () => {
  it('starts with blue in an empty project', () => {
    expect(suggestPhaseColor([], 'gray')).toBe('blue')
    expect(suggestPhaseColor([], 'red')).toBe('blue')
    expect(suggestPhaseColor([], 'blue')).toBe('blue')
  })

  it('gives eight appended phases eight distinct colours, gray last', () => {
    expect(append(8).map((p) => p.color)).toEqual(ORDER)
  })

  it('cycles predictably after the palette is used up and never repeats the previous phase', () => {
    const colors = append(24).map((p) => p.color)
    expect(colors).toEqual([...ORDER, ...ORDER, ...ORDER])
    for (let i = 1; i < colors.length; i++) expect(colors[i]).not.toBe(colors[i - 1])
  })

  it('skips colours already chosen by hand', () => {
    const phases: P[] = [
      { color: 'blue', sortOrder: key(0) },
      { color: 'pink', sortOrder: key(1) },
      { color: 'violet', sortOrder: key(2) },
    ]
    expect(suggestPhaseColor(phases, 'red')).toBe('orange')
  })

  it('counts a phase without its own colour as the project colour', () => {
    const phases: P[] = [
      { color: null, sortOrder: key(0) },
      { color: null, sortOrder: key(1) },
      { color: null, sortOrder: key(2) },
    ]
    // Three phases shown in blue: blue is the most used, so it is not suggested.
    expect(suggestPhaseColor(phases, 'blue')).toBe('violet')
  })

  it('lets a project colour outside the phase palette consume nothing', () => {
    const phases: P[] = [
      { color: null, sortOrder: key(0) },
      { color: null, sortOrder: key(1) },
    ]
    expect(suggestPhaseColor(phases, 'red')).toBe('blue')
    expect(suggestPhaseColor(phases, 'red')).toBe(suggestPhaseColor([], 'red'))
  })

  it('excludes the last phase colour even when it is the least used', () => {
    // Every colour is used twice except blue (once), and blue is the last phase.
    const phases: P[] = []
    for (const color of ORDER.filter((c) => c !== 'blue')) {
      phases.push({ color, sortOrder: key(phases.length) })
      phases.push({ color, sortOrder: key(phases.length) })
    }
    phases.push({ color: 'blue', sortOrder: key(phases.length) })
    expect(suggestPhaseColor(phases, 'red')).toBe('violet')
  })

  it('excludes the last phase colour when it is the project colour', () => {
    const phases: P[] = [
      { color: 'blue', sortOrder: key(0) },
      { color: 'violet', sortOrder: key(1) },
      { color: 'pink', sortOrder: key(2) },
      { color: null, sortOrder: key(3) },
    ]
    // A pink project: the last phase shows pink, which is also the most used.
    expect(suggestPhaseColor(phases, 'pink')).toBe('orange')
  })

  it('does not depend on the order of the input array', () => {
    const phases = append(11)
    const expected = suggestPhaseColor(phases, 'red')
    expect(suggestPhaseColor([...phases].reverse(), 'red')).toBe(expected)
    const shuffled = [3, 9, 0, 7, 10, 2, 5, 1, 8, 4, 6].map((i) => phases[i])
    expect(suggestPhaseColor(shuffled, 'red')).toBe(expected)
  })

  it('does not depend on the order when the last keys are duplicated', () => {
    const a: P = { color: 'blue', sortOrder: 'a1' }
    const b: P = { color: 'violet', sortOrder: 'a1' }
    expect(suggestPhaseColor([a, b], 'red')).toBe(suggestPhaseColor([b, a], 'red'))
    expect(suggestPhaseColor([a, b], 'red')).toBe('pink')
  })

  it('compares sortOrder as plain strings', () => {
    // 'a2' > 'a10' as code units, so the blue phase is the last one (not violet, as numbers would say).
    const phases: P[] = [
      { color: 'blue', sortOrder: 'a2' },
      { color: 'violet', sortOrder: 'a10' },
      ...ORDER.slice(2).map((color, index) => ({ color, sortOrder: `a0${index}` })),
    ]
    // Every colour is used once: only the exclusion of the last phase (blue) decides.
    expect(suggestPhaseColor(phases, 'red')).toBe('violet')
  })
})
