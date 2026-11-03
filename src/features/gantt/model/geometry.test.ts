import { describe, expect, it } from 'vitest'
import { toEpochDay } from '@/domain/dates'
import { makeDependency } from '@/domain/testFactories'
import { MARKER_HALF_WIDTH, MIN_BAR_WIDTH, ROW_HEIGHT } from './constants'
import {
  dayAtViewport,
  dayCenterX,
  dayToX,
  linkRoute,
  rangeRect,
  resizeHandleWidth,
  roundedPath,
  rowCenterY,
  scrollLeftForDay,
  snapDays,
  spanAnchors,
  xToDay,
  xToDayFloat,
  type TimelineGeometry,
} from './geometry'
import { buildLinkViews, type LinkEndpoint } from './links'

const d = toEpochDay
const day: TimelineGeometry = { originDay: d('2026-11-02'), dayWidth: 36 }
const month: TimelineGeometry = { originDay: d('2026-11-02'), dayWidth: 5 }

describe('day ↔ x', () => {
  it('round-trips and floors inside a day', () => {
    expect(dayToX(d('2026-11-05'), day)).toBe(3 * 36)
    expect(xToDay(3 * 36, day)).toBe(d('2026-11-05'))
    expect(xToDay(3 * 36 + 35.9, day)).toBe(d('2026-11-05'))
    expect(xToDay(-1, day)).toBe(d('2026-11-01'))
    expect(dayCenterX(d('2026-11-02'), day)).toBe(18)
    expect(xToDayFloat(54, day)).toBe(d('2026-11-02') + 1.5)
  })

  it('counts calendar days across month, year and leap-day boundaries', () => {
    expect(dayToX(d('2026-12-01'), day)).toBe(29 * 36)
    expect(dayToX(d('2027-01-01'), day)).toBe(60 * 36)
    const leap = { originDay: d('2028-02-28'), dayWidth: 36 }
    expect(xToDay(2 * 36, leap)).toBe(d('2028-03-01'))
    expect(xToDay(36, leap)).toBe(d('2028-02-29'))
  })
})

describe('rangeRect', () => {
  it('is inclusive: one day = one column', () => {
    expect(rangeRect(d('2026-11-03'), d('2026-11-03'), day)).toEqual({ left: 36, width: 36 })
    expect(rangeRect(d('2026-11-03'), d('2026-11-05'), day)).toEqual({ left: 36, width: 108 })
  })

  it('spans the year boundary', () => {
    const rect = rangeRect(d('2026-12-30'), d('2027-01-02'), day)
    expect(rect.width).toBe(4 * 36)
  })

  it('accepts either order', () => {
    expect(rangeRect(d('2026-11-05'), d('2026-11-03'), day)).toEqual({ left: 36, width: 108 })
  })

  it('widens tiny bars symmetrically to the minimum width', () => {
    const rect = rangeRect(d('2026-11-03'), d('2026-11-03'), month)
    expect(rect.width).toBe(MIN_BAR_WIDTH)
    expect(rect.left + rect.width / 2).toBe(5 + 2.5) // same centre as the day
  })
})

describe('snapDays / resize handles', () => {
  it('rounds to the nearest day and never returns -0', () => {
    expect(snapDays(0.49)).toBe(0)
    expect(snapDays(0.5)).toBe(1)
    expect(Object.is(snapDays(-0.4), 0)).toBe(true)
    expect(Object.is(snapDays(-0.5), 0)).toBe(true)
    expect(snapDays(-0.51)).toBe(-1)
    expect(snapDays(2.6)).toBe(3)
  })

  it('shrinks resize zones on narrow bars and drops them below 12px', () => {
    expect(resizeHandleWidth(200)).toBe(8)
    expect(resizeHandleWidth(20)).toBe(5)
    expect(resizeHandleWidth(11)).toBe(0)
  })
})

describe('spanAnchors', () => {
  it('range: bar edges', () => {
    expect(
      spanAnchors({ kind: 'range', start: d('2026-11-03'), end: d('2026-11-05') }, day),
    ).toEqual({ inX: 36, outX: 144 })
  })

  it('due only: either side of the due flag', () => {
    const center = dayCenterX(d('2026-11-04'), day)
    expect(spanAnchors({ kind: 'due_only', start: null, end: d('2026-11-04') }, day)).toEqual({
      inX: center - MARKER_HALF_WIDTH,
      outX: center + MARKER_HALF_WIDTH,
    })
  })

  it('start only: in at the start tick, out at the end of the start day; unscheduled: none', () => {
    const x = dayToX(d('2026-11-04'), day)
    expect(spanAnchors({ kind: 'start_only', start: d('2026-11-04'), end: null }, day)).toEqual({
      inX: x - 1,
      outX: x + 36,
    })
    // Narrow days still leave room for the connector.
    const mx = dayToX(d('2026-11-04'), month)
    expect(
      spanAnchors({ kind: 'start_only', start: d('2026-11-04'), end: null }, month)?.outX,
    ).toBe(mx + MARKER_HALF_WIDTH * 2)
    expect(spanAnchors({ kind: 'unscheduled', start: null, end: null }, day)).toBeNull()
  })
})

describe('linkRoute', () => {
  it('forward: out → elbow → in, arrow at the successor', () => {
    const route = linkRoute({ x: 100, y: 16 }, { x: 200, y: 80 }, 8, 0)
    expect(route.d).toBe('M100 16 L108 16 L108 80 L200 80')
    expect(route.backward).toBe(false)
    expect(route.mid).toEqual({ x: 108, y: 48 })
    expect(route.arrow).toBe('M194 76.5 L200 80 L194 83.5 Z')
  })

  it('backward (successor starts too early): S-route along the row boundary', () => {
    const route = linkRoute({ x: 200, y: 16 }, { x: 150, y: 80 }, 8, 0)
    expect(route.backward).toBe(true)
    expect(route.d).toBe('M200 16 L208 16 L208 32 L142 32 L142 80 L150 80')
    expect(route.mid).toEqual({ x: 175, y: 32 })
  })

  it('goes up when the successor is above', () => {
    const route = linkRoute({ x: 200, y: 80 }, { x: 150, y: 16 }, 8, 0)
    expect(route.d).toContain('L208 64')
    expect(route.top).toBe(16 - ROW_HEIGHT / 2)
    expect(route.bottom).toBe(80 + ROW_HEIGHT / 2)
  })

  it('rounds corners without overshooting short segments', () => {
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 2 },
        ],
        4,
      ),
    ).toBe('M0 0 L9 0 Q10 0 10 1 L10 2')
  })
})

describe('scroll helpers', () => {
  it('scrollLeftForDay is the inverse of dayAtViewport', () => {
    const target = d('2026-11-20') + 0.5
    const scrollLeft = scrollLeftForDay(target, 900, day, 1 / 3)
    expect(dayAtViewport(scrollLeft, 900, day, 1 / 3)).toBeCloseTo(target)
    expect(scrollLeftForDay(day.originDay, 900, day)).toBe(0) // never negative
  })
})

describe('buildLinkViews', () => {
  const rows = new Map<string, LinkEndpoint>([
    ['a', { rowIndex: 0, anchors: { inX: 0, outX: 100 } }],
    ['b', { rowIndex: 2, anchors: { inX: 150, outX: 300 } }],
    ['c', { rowIndex: 40, anchors: { inX: 50, outX: 80 } }],
  ])
  const endpoint = (id: string) => rows.get(id) ?? null
  const deps = [
    makeDependency({ id: 'ab', projectId: 'p', predecessorId: 'a', successorId: 'b' }),
    makeDependency({ id: 'bc', projectId: 'p', predecessorId: 'b', successorId: 'c' }),
    makeDependency({ id: 'ax', projectId: 'p', predecessorId: 'a', successorId: 'hidden' }),
  ]

  it('skips links with a hidden endpoint and links outside the rendered rows', () => {
    const views = buildLinkViews({
      dependencies: deps,
      endpoint,
      conflictIds: new Set(['bc']),
      firstRow: 0,
      lastRow: 10,
    })
    // 'bc' crosses rows 2…40 so it intersects 0…10; 'ax' has no successor row.
    expect(views.map((v) => [v.id, v.conflict])).toEqual([
      ['ab', false],
      ['bc', true],
    ])
    expect(
      buildLinkViews({ dependencies: deps, endpoint, conflictIds: new Set(), firstRow: 20, lastRow: 30 }).map(
        (v) => v.id,
      ),
    ).toEqual(['bc'])
    expect(
      buildLinkViews({ dependencies: deps, endpoint, conflictIds: new Set(), firstRow: 41, lastRow: 60 }),
    ).toEqual([])
  })

  it('routes from the predecessor out anchor to the successor in anchor at row centres', () => {
    const [ab] = buildLinkViews({
      dependencies: deps.slice(0, 1),
      endpoint,
      conflictIds: new Set(),
      firstRow: 0,
      lastRow: 5,
    })
    expect(ab.route.d.startsWith(`M100 ${rowCenterY(0)}`)).toBe(true)
    expect(ab.route.d.endsWith(`L150 ${rowCenterY(2)}`)).toBe(true)
  })
})
