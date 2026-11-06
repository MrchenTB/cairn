import { describe, expect, it } from 'vitest'
import { fromEpochDay, toEpochDay } from '@/domain/dates'
import {
  MAX_RANGE_DAYS,
  SCALES,
  buildHeaderTiers,
  eachUnit,
  extendRange,
  gridBackgroundStyle,
  weekendBandVars,
  gridLines,
  isWeekendDay,
  labelOverlapsPill,
  renderWindow,
  timelineRange,
  visibleDayRange,
} from './scale'

const d = toEpochDay
const iso = fromEpochDay
// Calendar facts used below: 2026-11-02 is a Monday; 2027 is not a leap year, 2028 is.

describe('SCALES', () => {
  it('uses 36 / 16 / 5 px per day', () => {
    expect(SCALES.day.dayWidth).toBe(36)
    expect(SCALES.week.dayWidth).toBe(16)
    expect(SCALES.month.dayWidth).toBe(5)
  })
})

describe('timelineRange', () => {
  const data = { start: d('2026-11-10'), end: d('2026-11-20') }
  const today = d('2026-11-03')

  it('pads data ∪ today and aligns Day/Week to whole weeks (Monday start)', () => {
    const range = timelineRange(data, today, 'day', 1)
    // today − 14 = Tue Oct 20 → Mon Oct 19; Nov 20 + 14 = Fri Dec 4 → Sun Dec 6
    expect(iso(range.start)).toBe('2026-10-19')
    expect(iso(range.end)).toBe('2026-12-06')
  })

  it('honours a Sunday week start', () => {
    const range = timelineRange(data, today, 'day', 0)
    expect(iso(range.start)).toBe('2026-10-18')
    expect(iso(range.end)).toBe('2026-12-05')
  })

  it('aligns Month to whole months across the year boundary', () => {
    const range = timelineRange(data, today, 'month', 1)
    // today − 92 = Aug 3 → Aug 1; Nov 20 + 92 = Feb 20 2027 → Feb 28 2027
    expect(iso(range.start)).toBe('2026-08-01')
    expect(iso(range.end)).toBe('2027-02-28')
  })

  it('works from today alone when nothing is scheduled', () => {
    const range = timelineRange(null, today, 'week', 1)
    expect(range.start).toBeLessThanOrEqual(today - SCALES.week.paddingDays)
    expect(range.end).toBeGreaterThanOrEqual(today + SCALES.week.paddingDays)
  })

  it('always includes today, even far from the data', () => {
    const range = timelineRange({ start: d('2030-01-01'), end: d('2030-01-05') }, today, 'day', 1)
    expect(range.start).toBeLessThanOrEqual(today)
    expect(range.end).toBeGreaterThanOrEqual(d('2030-01-05'))
  })

  it('is at least minDays long (fills the viewport)', () => {
    const range = timelineRange(null, today, 'day', 1, 200)
    expect(range.end - range.start + 1).toBeGreaterThanOrEqual(200)
  })
})

describe('extendRange', () => {
  const range = { start: d('2026-11-02'), end: d('2026-11-29') }

  it('grows one side, aligned to the scale unit', () => {
    const left = extendRange(range, 'start', 10, 'week', 1)
    expect(iso(left.start)).toBe('2026-10-19') // Oct 23 → Monday Oct 19
    expect(left.end).toBe(range.end)
    const right = extendRange(range, 'end', 40, 'month', 1)
    expect(iso(right.end)).toBe('2027-01-31')
    expect(right.start).toBe(range.start)
  })

  it('stops growing at MAX_RANGE_DAYS', () => {
    const huge = { start: 0, end: MAX_RANGE_DAYS }
    expect(extendRange(huge, 'end', 100, 'day', 1)).toBe(huge)
  })
})

describe('eachUnit', () => {
  it('lists every unit intersecting the interval', () => {
    const weeks = eachUnit(d('2026-11-04'), d('2026-11-17'), 'week', 1)
    expect(weeks.map(([s, e]) => [iso(s), iso(e)])).toEqual([
      ['2026-11-02', '2026-11-08'],
      ['2026-11-09', '2026-11-15'],
      ['2026-11-16', '2026-11-22'],
    ])
    const years = eachUnit(d('2026-12-01'), d('2027-01-10'), 'year', 1)
    expect(years.map(([s, e]) => [iso(s), iso(e)])).toEqual([
      ['2026-01-01', '2026-12-31'],
      ['2027-01-01', '2027-12-31'],
    ])
  })

  it('returns nothing for an empty interval', () => {
    expect(eachUnit(10, 9, 'day', 1)).toEqual([])
  })
})

describe('buildHeaderTiers', () => {
  it('Day: months on top, days below, weekends and today flagged, across a month boundary', () => {
    const range = { start: d('2026-10-26'), end: d('2026-11-08') }
    const tiers = buildHeaderTiers({
      scale: 'day',
      range,
      window: range,
      dayWidth: 36,
      weekStartsOn: 1,
      today: d('2026-11-03'),
    })
    expect(tiers.top.map((c) => [c.label, c.x, c.width])).toEqual([
      ['Oct 2026', 0, 6 * 36],
      ['Nov 2026', 6 * 36, 8 * 36],
    ])
    expect(tiers.bottom).toHaveLength(14)
    const nov2 = tiers.bottom.find((c) => c.startDay === d('2026-11-02'))
    expect(nov2).toMatchObject({ label: '2', prefix: 'M', x: 7 * 36, width: 36, weekend: false })
    expect(nov2?.title).toBe('Monday, November 2, 2026')
    expect(tiers.bottom.filter((c) => c.weekend).map((c) => iso(c.startDay))).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-07',
      '2026-11-08',
    ])
    expect(tiers.bottom.filter((c) => c.today).map((c) => iso(c.startDay))).toEqual(['2026-11-03'])
    expect(tiers.top.find((c) => c.today)?.label).toBe('Nov 2026')
  })

  it('Week: week cells start on the configured weekday', () => {
    const monday = buildHeaderTiers({
      scale: 'week',
      range: { start: d('2026-11-02'), end: d('2026-11-29') },
      window: { start: d('2026-11-02'), end: d('2026-11-29') },
      dayWidth: 16,
      weekStartsOn: 1,
      today: 0,
    })
    expect(monday.bottom.map((c) => c.label)).toEqual(['Nov 2', 'Nov 9', 'Nov 16', 'Nov 23'])
    expect(monday.bottom.map((c) => c.width)).toEqual([112, 112, 112, 112])
    const sunday = buildHeaderTiers({
      scale: 'week',
      range: { start: d('2026-11-01'), end: d('2026-11-28') },
      window: { start: d('2026-11-01'), end: d('2026-11-28') },
      dayWidth: 16,
      weekStartsOn: 0,
      today: 0,
    })
    expect(sunday.bottom.map((c) => c.label)).toEqual(['Nov 1', 'Nov 8', 'Nov 15', 'Nov 22'])
    expect(sunday.bottom[0].title).toBe('Week of Nov 1, 2026')
  })

  it('Month: years on top, months below, across a year and a leap February', () => {
    const range = { start: d('2027-11-01'), end: d('2028-03-31') }
    const tiers = buildHeaderTiers({
      scale: 'month',
      range,
      window: range,
      dayWidth: 5,
      weekStartsOn: 1,
      today: 0,
    })
    expect(tiers.top.map((c) => [c.label, c.width])).toEqual([
      ['2027', 61 * 5],
      ['2028', 91 * 5],
    ])
    expect(tiers.bottom.map((c) => [c.label, c.width])).toEqual([
      ['Nov', 30 * 5],
      ['Dec', 31 * 5],
      ['Jan', 31 * 5],
      ['Feb', 29 * 5],
      ['Mar', 31 * 5],
    ])
    expect(tiers.bottom[3].title).toBe('February 2028')
  })

  it('clips edge cells to the range and renders only the window', () => {
    const range = { start: d('2026-11-04'), end: d('2026-12-31') }
    const tiers = buildHeaderTiers({
      scale: 'day',
      range,
      window: { start: d('2026-11-20'), end: d('2026-11-22') },
      dayWidth: 36,
      weekStartsOn: 1,
      today: 0,
    })
    expect(tiers.bottom.map((c) => iso(c.startDay))).toEqual([
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ])
    // The November cell starts before the range: clipped to x = 0, 27 days wide.
    expect(tiers.top[0]).toMatchObject({ label: 'Nov 2026', x: 0, width: 27 * 36 })
  })
})

describe('gridLines', () => {
  it('Day/Week: strong month boundaries inside the window, none at the range start', () => {
    const range = { start: d('2026-11-01'), end: d('2027-01-31') }
    const lines = gridLines({ scale: 'week', range, window: range, dayWidth: 16 })
    expect(lines.map((l) => [iso(range.start + l.x / 16), l.strong])).toEqual([
      ['2026-12-01', true],
      ['2027-01-01', true],
    ])
  })

  it('Month: month lines are light, year lines strong', () => {
    const range = { start: d('2026-11-01'), end: d('2027-02-28') }
    const lines = gridLines({ scale: 'month', range, window: range, dayWidth: 5 })
    expect(lines.map((l) => [iso(range.start + l.x / 5), l.strong])).toEqual([
      ['2026-12-01', false],
      ['2027-01-01', true],
      ['2027-02-01', false],
    ])
  })
})

describe('gridBackgroundStyle', () => {
  it('draws the week/day line tile and a Saturday + Sunday band, both aligned to the origin weekday', () => {
    const origin = d('2026-10-26') // Monday
    const monday = gridBackgroundStyle('day', origin, 36, 1)
    expect(monday?.backgroundImage.split('linear-gradient')).toHaveLength(3) // 2 layers
    expect(monday?.backgroundImage).toContain('--gantt-weekend')
    // hairline at Monday (offset 0), band from Saturday (5 days later), two days wide
    expect(monday?.backgroundPosition).toBe(`0px 0, ${5 * 36}px 0`)
    expect(monday?.backgroundSize).toBe(`${7 * 36}px 100%, ${7 * 36}px 100%`)
    expect(monday?.backgroundImage).toContain(`var(--gantt-weekend) 0 ${2 * 36}px`)
    const sunday = gridBackgroundStyle('week', origin, 16, 0)
    expect(sunday?.backgroundPosition).toBe(`${6 * 16}px 0, ${5 * 16}px 0`)
    expect(sunday?.backgroundSize).toBe(`${7 * 16}px 100%, ${7 * 16}px 100%`)
  })

  it('the band does not depend on which day the week starts, the hairline does', () => {
    const origin = d('2026-10-26')
    const mon = gridBackgroundStyle('week', origin, 16, 1)
    const sun = gridBackgroundStyle('week', origin, 16, 0)
    expect(mon?.backgroundPosition.split(', ')[1]).toBe(sun?.backgroundPosition.split(', ')[1])
    expect(mon?.backgroundPosition.split(', ')[0]).not.toBe(sun?.backgroundPosition.split(', ')[0])
  })

  it('Day and Week draw the week hairline plus six fainter day lines in one tile', () => {
    const origin = d('2026-10-26')
    for (const [scale, width] of [
      ['day', 36],
      ['week', 16],
    ] as const) {
      const image = gridBackgroundStyle(scale, origin, width, 1)?.backgroundImage ?? ''
      expect(image).toContain('var(--gantt-grid) 0 1px') // week start, same colour on both
      expect(image).not.toContain('grid-strong')
      // six day lines, each 1px wide at its own day boundary inside the week
      for (let day = 1; day < 7; day++) {
        expect(image).toContain(`${day * width}px ${day * width + 1}px`)
      }
      expect(image.match(/--gantt-day-line/g)).toHaveLength(6)
      // still one tile per week for the lines and one for the band (no extra layers)
      expect(image.split('linear-gradient')).toHaveLength(3)
    }
  })

  it('Week day lines are fainter than Day day lines', () => {
    const origin = d('2026-10-26')
    expect(gridBackgroundStyle('day', origin, 36, 1)?.backgroundImage).not.toContain('color-mix')
    expect(gridBackgroundStyle('week', origin, 16, 1)?.backgroundImage).toContain(
      'color-mix(in srgb, var(--gantt-day-line) 75%, transparent)',
    )
  })

  it('exposes the band and the lines as CSS variables for chips; none on Month', () => {
    const origin = d('2026-10-26') // Monday
    expect(weekendBandVars('day', origin, 36, 1)).toEqual({
      '--wk-image': expect.stringContaining('--gantt-weekend'),
      '--wk-size': `${7 * 36}px 100%`,
      '--wk-x': `${5 * 36}px`,
      '--wk-lines': expect.stringContaining('--gantt-day-line'),
      '--wk-lx': '0px',
    })
    // the line tile follows the week start (Sunday: 6 days after a Monday origin), the band does not
    const sunday = weekendBandVars('week', origin, 16, 0)
    expect(sunday['--wk-lx']).toBe(`${6 * 16}px`)
    expect(sunday['--wk-x']).toBe(`${5 * 16}px`)
    expect(weekendBandVars('month', origin, 5)).toEqual({})
  })

  it('Month draws no regular grid', () => {
    expect(gridBackgroundStyle('month', d('2026-11-01'), 5, 1)).toBeNull()
  })
})

describe('visible window', () => {
  it('maps scroll position to visible days', () => {
    const origin = d('2026-11-02')
    const visible = visibleDayRange(36 * 3 + 5, 36 * 10, origin, 36)
    expect(iso(visible.start)).toBe('2026-11-05')
    expect(iso(visible.end)).toBe('2026-11-15')
  })

  it('renders one extra viewport per side and keeps the window while inside it', () => {
    const first = renderWindow({ start: 100, end: 109 }, null)
    expect(first).toEqual({ start: 90, end: 119 })
    expect(renderWindow({ start: 95, end: 104 }, first)).toBe(first)
    expect(renderWindow({ start: 115, end: 124 }, first)).toEqual({ start: 105, end: 134 })
  })

  it('knows weekends', () => {
    expect(isWeekendDay(d('2026-11-07'))).toBe(true)
    expect(isWeekendDay(d('2026-11-08'))).toBe(true)
    expect(isWeekendDay(d('2026-11-09'))).toBe(false)
  })
})

describe('labelOverlapsPill', () => {
  // A Week cell is 112px wide with its label ("Nov 2", ~30px) starting 6px in; the pill is ~42px.
  const label = { left: 6, width: 30 }
  const half = 21

  it('is true when today falls on the first days of the week (the pill would cover the label)', () => {
    for (const todayX of [8, 24, 40]) {
      expect(labelOverlapsPill(label.left, label.width, todayX, half)).toBe(true)
    }
  })

  it('is false once the pill has moved clear of the label', () => {
    for (const todayX of [72, 88, 104]) {
      expect(labelOverlapsPill(label.left, label.width, todayX, half)).toBe(false)
    }
  })

  it('keeps a small gap: a pill that almost touches the label still hides it', () => {
    // Label ends at 36; a pill starting at 38 is within the 4px gap, one starting at 41 is not.
    expect(labelOverlapsPill(label.left, label.width, 38 + half, half)).toBe(true)
    expect(labelOverlapsPill(label.left, label.width, 41 + half, half)).toBe(false)
  })

  it('also hides a label the pill sits entirely to the left of (today in the previous cell)', () => {
    expect(labelOverlapsPill(120, 30, 100, half)).toBe(true)
    expect(labelOverlapsPill(160, 30, 100, half)).toBe(false)
  })
})

describe('the ends of the supported calendar', () => {
  it('eachUnit stops at the last year and month without leaving the calendar', () => {
    const lastDay = d('9999-12-31')
    expect(eachUnit(d('9999-06-01'), lastDay, 'year', 1)).toEqual([[d('9999-01-01'), lastDay]])
    expect(eachUnit(d('9999-11-10'), d('9999-11-20'), 'month', 1)).toEqual([
      [d('9999-11-01'), d('9999-11-30')],
    ])
    expect(eachUnit(d('0001-01-01'), d('0001-03-01'), 'year', 1)[0][0]).toBe(d('0001-01-01'))
  })

  it.each(['day', 'week', 'month'] as const)(
    'builds a %s header for data on either end of the calendar',
    (scale) => {
      const today = d('2026-11-04')
      for (const bounds of [
        { start: d('9999-12-20'), end: d('9999-12-31') },
        { start: d('0001-01-01'), end: d('0001-01-02') },
        { start: d('0001-01-01'), end: d('9999-12-31') },
      ]) {
        const range = timelineRange(bounds, today, scale, 1)
        for (const window of [
          { start: range.end - 400, end: range.end + 400 },
          { start: range.start - 400, end: range.start + 400 },
        ]) {
          const { dayWidth } = SCALES[scale]
          const options = { scale, range, window, dayWidth, weekStartsOn: 1 as const, today }
          expect(buildHeaderTiers(options).bottom.length).toBeGreaterThan(0)
          expect(() => gridLines({ scale, range, window, dayWidth })).not.toThrow()
        }
      }
    },
  )
})
