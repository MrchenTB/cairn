import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  assertISODate,
  clampDate,
  compareISODate,
  dayOfWeek,
  daysInMonth,
  diffDays,
  durationDays,
  eachDay,
  endOfMonth,
  endOfWeek,
  formatDate,
  formatDateRange,
  formatDateSmart,
  fromEpochDay,
  fromLocalDate,
  getBrowserTimeZone,
  isISODate,
  isLeapYear,
  isoWeekNumber,
  isValidTimeZone,
  isWeekend,
  makeISODate,
  maxDate,
  minDate,
  parseISODate,
  startOfMonth,
  startOfWeek,
  toEpochDay,
  todayInTimeZone,
  toLocalDate,
  tryFromEpochDay,
  tryToEpochDay,
  type DateFormatStyle,
} from './dates'

/** Independent oracle: epoch day via Date.UTC semantics (setUTCFullYear handles years < 100). */
function utcEpochDay(year: number, month: number, day: number): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  return date.getTime() / 86_400_000
}

describe('isISODate / parsing', () => {
  it.each([
    '2026-11-02',
    '2024-02-29',
    '2028-02-29',
    '2000-02-29',
    '0001-01-01',
    '9999-12-31',
    '1969-12-31',
  ])('accepts %s', (value) => {
    expect(isISODate(value)).toBe(true)
  })

  it.each([
    '2026-02-29', // not a leap year
    '2100-02-29', // century, not divisible by 400
    '1900-02-29',
    '2026-02-30',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-11-00',
    '0000-01-01', // no year zero (PostgreSQL rejects it)
    '2026-1-1',
    '2026/11/02',
    ' 2026-11-02',
    '2026-11-02 ',
    '2026-11-02T00:00:00Z',
    '20261102',
    '２０２６-１１-０２', // full-width digits
    '+2026-11-02',
    '',
  ])('rejects %j', (value) => {
    expect(isISODate(value)).toBe(false)
  })

  it('rejects non-strings', () => {
    for (const value of [null, undefined, 20261102, new Date(0), {}, ['2026-11-02']]) {
      expect(isISODate(value)).toBe(false)
    }
  })

  it('knows the Gregorian leap-year rule', () => {
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2028)).toBe(true)
    expect(isLeapYear(2000)).toBe(true)
    expect(isLeapYear(2100)).toBe(false)
    expect(isLeapYear(1900)).toBe(false)
    expect(isLeapYear(2026)).toBe(false)
  })

  it('assertISODate returns valid dates and throws RangeError otherwise', () => {
    expect(assertISODate('2026-11-02')).toBe('2026-11-02')
    expect(() => assertISODate('2026-02-30')).toThrow(RangeError)
    expect(() => assertISODate('nope')).toThrow(RangeError)
  })

  it('parseISODate returns 1-based months', () => {
    expect(parseISODate('2026-11-02')).toEqual({ year: 2026, month: 11, day: 2 })
    expect(parseISODate('0042-01-09')).toEqual({ year: 42, month: 1, day: 9 })
    expect(() => parseISODate('2026-11-31')).toThrow(RangeError)
  })

  it('makeISODate pads and validates', () => {
    expect(makeISODate(2026, 11, 2)).toBe('2026-11-02')
    expect(makeISODate(42, 3, 4)).toBe('0042-03-04')
    expect(makeISODate(2024, 2, 29)).toBe('2024-02-29')
    for (const [y, m, d] of [
      [2026, 2, 29],
      [2026, 2, 30],
      [2100, 2, 29],
      [2026, 13, 1],
      [2026, 0, 1],
      [2026, 1, 0],
      [0, 1, 1],
      [10_000, 1, 1],
      [2026.5, 1, 1],
      [2026, 1, Number.NaN],
    ]) {
      expect(() => makeISODate(y, m, d)).toThrow(RangeError)
    }
  })
})

describe('epoch days', () => {
  it('matches known values, including negative epoch days', () => {
    expect(toEpochDay('1970-01-01')).toBe(0)
    expect(toEpochDay('1970-01-02')).toBe(1)
    expect(toEpochDay('1969-12-31')).toBe(-1)
    expect(toEpochDay('1900-01-01')).toBe(-25_567)
    expect(toEpochDay('2000-01-01')).toBe(10_957)
    expect(toEpochDay('2026-11-02')).toBe(20_759)
    expect(toEpochDay('0001-01-01')).toBe(-719_162)
    expect(toEpochDay('9999-12-31')).toBe(2_932_896)
    expect(fromEpochDay(-1)).toBe('1969-12-31')
    expect(fromEpochDay(-25_567)).toBe('1900-01-01')
    expect(fromEpochDay(-719_162)).toBe('0001-01-01')
    expect(fromEpochDay(2_932_896)).toBe('9999-12-31')
  })

  it('agrees with Date.UTC across the whole supported range', () => {
    for (let epochDay = -719_162; epochDay <= 2_932_896; epochDay += 997) {
      const date = fromEpochDay(epochDay)
      const { year, month, day } = parseISODate(date)
      expect(utcEpochDay(year, month, day)).toBe(epochDay)
      expect(toEpochDay(date)).toBe(epochDay)
    }
  })

  it('round-trips every day from 1899 to 2101 (covers 1900, 2000 and 2100)', () => {
    let previous = toEpochDay('1898-12-31')
    for (const date of eachDay('1899-01-01', '2101-12-31')) {
      const epochDay = toEpochDay(date)
      expect(epochDay).toBe(previous + 1)
      expect(fromEpochDay(epochDay)).toBe(date)
      previous = epochDay
    }
  })

  it('rejects invalid input', () => {
    expect(() => toEpochDay('2026-02-30')).toThrow(RangeError)
    expect(() => fromEpochDay(1.5)).toThrow(RangeError)
    expect(() => fromEpochDay(Number.NaN)).toThrow(RangeError)
    expect(() => fromEpochDay(-719_163)).toThrow(RangeError)
    expect(() => fromEpochDay(2_932_897)).toThrow(RangeError)
  })

  it('has non-throwing variants', () => {
    expect(tryToEpochDay('1970-01-02')).toBe(1)
    expect(tryToEpochDay('2026-02-30')).toBeNull()
    expect(tryToEpochDay(null)).toBeNull()
    expect(tryFromEpochDay(0)).toBe('1970-01-01')
    expect(tryFromEpochDay(2_932_897)).toBeNull()
    expect(tryFromEpochDay(0.5)).toBeNull()
  })
})

describe('arithmetic', () => {
  it.each([
    ['2026-01-31', 1, '2026-02-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2027-01-01', -1, '2026-12-31'],
    ['2024-02-28', 1, '2024-02-29'],
    ['2024-02-29', 1, '2024-03-01'],
    ['2023-02-28', 1, '2023-03-01'],
    ['2100-02-28', 1, '2100-03-01'],
    ['2000-02-28', 1, '2000-02-29'],
    ['2028-03-01', -1, '2028-02-29'],
    ['2026-03-01', -1, '2026-02-28'],
    ['1970-01-01', -1, '1969-12-31'],
    ['2026-11-02', 365, '2027-11-02'],
    ['2024-01-01', 366, '2025-01-01'],
    ['2026-11-02', 0, '2026-11-02'],
    ['2026-11-02', -20_759, '1970-01-01'],
  ])('addDays(%s, %i) = %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected)
  })

  it('addDays rejects fractional days and leaving the supported range', () => {
    expect(() => addDays('2026-11-02', 0.5)).toThrow(RangeError)
    expect(() => addDays('9999-12-31', 1)).toThrow(RangeError)
    expect(() => addDays('0001-01-01', -1)).toThrow(RangeError)
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError)
  })

  it.each([
    ['2026-01-31', 1, '2026-02-28'],
    ['2024-01-31', 1, '2024-02-29'],
    ['2026-03-31', -1, '2026-02-28'],
    ['2026-05-31', 1, '2026-06-30'],
    ['2026-12-15', 1, '2027-01-15'],
    ['2026-01-15', -1, '2025-12-15'],
    ['2026-11-02', 12, '2027-11-02'],
    ['2026-11-02', -24, '2024-11-02'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2024-02-29', 48, '2028-02-29'],
    ['2099-02-28', 12, '2100-02-28'],
    ['2026-11-02', 0, '2026-11-02'],
  ])('addMonths(%s, %i) = %s', (date, months, expected) => {
    expect(addMonths(date, months)).toBe(expected)
  })

  it('addMonths rejects fractional months and out-of-range results', () => {
    expect(() => addMonths('2026-11-02', 1.5)).toThrow(RangeError)
    expect(() => addMonths('9999-12-01', 1)).toThrow(RangeError)
  })

  it('diffDays / durationDays', () => {
    expect(diffDays('2026-11-01', '2026-11-03')).toBe(2)
    expect(diffDays('2026-11-03', '2026-11-01')).toBe(-2)
    expect(diffDays('2024-01-01', '2025-01-01')).toBe(366)
    expect(diffDays('2026-01-01', '2027-01-01')).toBe(365)
    expect(diffDays('2100-02-28', '2100-03-01')).toBe(1)
    expect(diffDays('1969-12-31', '1970-01-01')).toBe(1)
    expect(durationDays('2026-11-02', '2026-11-04')).toBe(3)
    expect(durationDays('2026-11-02', '2026-11-02')).toBe(1)
    expect(durationDays('2026-12-30', '2027-01-02')).toBe(4)
  })

  it('compare / min / max / clamp', () => {
    expect(compareISODate('2026-11-02', '2026-11-03')).toBe(-1)
    expect(compareISODate('2026-11-03', '2026-11-02')).toBe(1)
    expect(compareISODate('2026-11-02', '2026-11-02')).toBe(0)
    expect(compareISODate('0999-12-31', '1000-01-01')).toBe(-1)
    expect(minDate('2026-11-05', null, '2026-11-02', undefined, '')).toBe('2026-11-02')
    expect(maxDate('2026-11-05', null, '2027-01-01', undefined)).toBe('2027-01-01')
    expect(minDate()).toBeNull()
    expect(maxDate(null, undefined, '')).toBeNull()
    expect(clampDate('2026-11-10', '2026-11-01', '2026-11-05')).toBe('2026-11-05')
    expect(clampDate('2026-10-10', '2026-11-01', '2026-11-05')).toBe('2026-11-01')
    expect(clampDate('2026-11-03', '2026-11-01', '2026-11-05')).toBe('2026-11-03')
    expect(clampDate('2026-11-03', '2026-11-05', '2026-11-01')).toBe('2026-11-05') // min wins
  })
})

describe('weeks and months', () => {
  it('dayOfWeek / isWeekend', () => {
    expect(dayOfWeek('2026-11-02')).toBe(1) // Monday
    expect(dayOfWeek('1970-01-01')).toBe(4) // Thursday
    expect(dayOfWeek('1969-12-31')).toBe(3)
    expect(dayOfWeek('2000-01-01')).toBe(6)
    expect(dayOfWeek('0001-01-01')).toBe(1)
    expect(dayOfWeek('9999-12-31')).toBe(5)
    expect(isWeekend('2026-11-07')).toBe(true)
    expect(isWeekend('2026-11-08')).toBe(true)
    expect(isWeekend('2026-11-09')).toBe(false)
  })

  it('agrees with Date.getUTCDay for a sweep of dates', () => {
    for (let epochDay = -30_000; epochDay < 30_000; epochDay += 37) {
      expect(dayOfWeek(fromEpochDay(epochDay))).toBe(new Date(epochDay * 86_400_000).getUTCDay())
    }
  })

  it('startOfWeek / endOfWeek for both week starts', () => {
    expect(startOfWeek('2026-11-04', 1)).toBe('2026-11-02')
    expect(endOfWeek('2026-11-04', 1)).toBe('2026-11-08')
    expect(startOfWeek('2026-11-04', 0)).toBe('2026-11-01')
    expect(endOfWeek('2026-11-04', 0)).toBe('2026-11-07')
    expect(startOfWeek('2026-11-08', 1)).toBe('2026-11-02') // Sunday, Monday-start week
    expect(startOfWeek('2026-11-08', 0)).toBe('2026-11-08')
    expect(startOfWeek('2026-11-02', 1)).toBe('2026-11-02')
    expect(startOfWeek('2027-01-01', 1)).toBe('2026-12-28')
    expect(endOfWeek('2027-01-01', 1)).toBe('2027-01-03')
    expect(startOfWeek('2024-03-01', 0)).toBe('2024-02-25')
  })

  it('startOfMonth / endOfMonth / daysInMonth', () => {
    expect(startOfMonth('2026-02-15')).toBe('2026-02-01')
    expect(endOfMonth('2026-02-15')).toBe('2026-02-28')
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29')
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29')
    expect(endOfMonth('2100-02-10')).toBe('2100-02-28')
    expect(endOfMonth('2000-02-10')).toBe('2000-02-29')
    expect(endOfMonth('2026-12-31')).toBe('2026-12-31')
    expect(endOfMonth('2026-04-01')).toBe('2026-04-30')
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2100, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(daysInMonth(2026, 12)).toBe(31)
    expect(() => daysInMonth(2026, 0)).toThrow(RangeError)
    expect(() => daysInMonth(2026, 13)).toThrow(RangeError)
    expect(() => daysInMonth(2026, 1.5)).toThrow(RangeError)
  })

  it('eachDay is inclusive and crosses month/year boundaries', () => {
    expect(eachDay('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ])
    expect(eachDay('2024-02-28', '2024-03-01')).toEqual(['2024-02-28', '2024-02-29', '2024-03-01'])
    expect(eachDay('2026-11-02', '2026-11-02')).toEqual(['2026-11-02'])
    expect(eachDay('2026-11-03', '2026-11-02')).toEqual([])
  })

  it.each([
    ['2026-01-01', 1], // Thursday: week 1 of 2026
    ['2025-12-29', 1], // Monday of 2026-W01
    ['2026-11-02', 45],
    ['2026-12-31', 53], // 2026 has 53 ISO weeks
    ['2027-01-03', 53], // still 2026-W53
    ['2027-01-04', 1],
    ['2024-12-30', 1], // belongs to 2025-W01
    ['2020-12-31', 53],
    ['2021-01-03', 53],
    ['2021-01-04', 1],
    ['2023-01-01', 52], // Sunday: 2022-W52
  ])('isoWeekNumber(%s) = %i', (date, week) => {
    expect(isoWeekNumber(date)).toBe(week)
  })
})

describe('todayInTimeZone', () => {
  const at = (iso: string) => new Date(iso)

  it('uses the zone, not the machine, to decide the date', () => {
    expect(todayInTimeZone('Asia/Taipei', at('2026-11-01T16:30:00Z'))).toBe('2026-11-02')
    expect(todayInTimeZone('Asia/Taipei', at('2026-11-01T15:59:59Z'))).toBe('2026-11-01')
    expect(todayInTimeZone('Asia/Taipei', at('2026-11-01T16:00:00Z'))).toBe('2026-11-02')
    expect(todayInTimeZone('UTC', at('2026-11-01T16:30:00Z'))).toBe('2026-11-01')
    expect(todayInTimeZone('UTC', at('2026-11-01T23:59:59.999Z'))).toBe('2026-11-01')
    expect(todayInTimeZone('UTC', at('2026-11-02T00:00:00Z'))).toBe('2026-11-02')
  })

  it('handles DST transitions and extreme offsets', () => {
    // US DST ended 2026-11-01: Los Angeles is UTC-8 afterwards.
    expect(todayInTimeZone('America/Los_Angeles', at('2026-11-02T07:59:59Z'))).toBe('2026-11-01')
    expect(todayInTimeZone('America/Los_Angeles', at('2026-11-02T08:00:00Z'))).toBe('2026-11-02')
    // US DST started 2026-03-08 at 02:00 PST: midnight is still UTC-8.
    expect(todayInTimeZone('America/Los_Angeles', at('2026-03-08T07:59:59Z'))).toBe('2026-03-07')
    expect(todayInTimeZone('America/Los_Angeles', at('2026-03-08T08:00:00Z'))).toBe('2026-03-08')
    expect(todayInTimeZone('Pacific/Kiritimati', at('2026-11-01T09:59:59Z'))).toBe('2026-11-01')
    expect(todayInTimeZone('Pacific/Kiritimati', at('2026-11-01T10:00:00Z'))).toBe('2026-11-02')
    expect(todayInTimeZone('Etc/GMT+12', at('2026-11-02T11:59:59Z'))).toBe('2026-11-01')
    expect(todayInTimeZone('Etc/GMT+12', at('2026-11-02T12:00:00Z'))).toBe('2026-11-02')
  })

  it('crosses year and leap-day boundaries', () => {
    expect(todayInTimeZone('Asia/Taipei', at('2026-12-31T16:00:00Z'))).toBe('2027-01-01')
    expect(todayInTimeZone('America/Los_Angeles', at('2027-01-01T07:00:00Z'))).toBe('2026-12-31')
    expect(todayInTimeZone('Asia/Taipei', at('2028-02-28T16:00:00Z'))).toBe('2028-02-29')
  })

  it('advances one day per local midnight through every 2026 DST change (hourly sweep)', () => {
    const zones = [
      'America/Los_Angeles',
      'America/Santiago', // DST changes at local midnight
      'Asia/Beirut', // DST changes at local midnight
      'Australia/Lord_Howe', // 30-minute DST
      'Europe/London',
      'Pacific/Kiritimati',
      'Pacific/Pago_Pago',
    ]
    for (const zone of zones) {
      // Independent reading of the same instant through another locale's format.
      const check = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      })
      let previous = todayInTimeZone(zone, at('2026-01-01T00:00:00Z'))
      const seen = new Set([previous])
      for (let hour = 1; hour <= 365 * 24; hour++) {
        const now = new Date(Date.UTC(2026, 0, 1, hour))
        const today = todayInTimeZone(zone, now)
        if (today !== previous) {
          expect([zone, now.toISOString(), diffDays(previous, today)]).toEqual([
            zone,
            now.toISOString(),
            1,
          ])
          seen.add(today)
          previous = today
        }
        if (hour % 97 === 0) {
          const [month, day, year] = check.format(now).split('/').map(Number)
          expect(today).toBe(makeISODate(year, month, day))
        }
      }
      expect(seen.size).toBe(366) // no calendar day skipped or repeated
    }
  })

  it('falls back to the browser zone for invalid zones', () => {
    const now = at('2026-11-01T16:30:00Z')
    const expected = todayInTimeZone(getBrowserTimeZone(), now)
    expect(todayInTimeZone('Not/AZone', now)).toBe(expected)
    expect(todayInTimeZone('', now)).toBe(expected)
  })

  it('defaults to the current instant', () => {
    expect(isISODate(todayInTimeZone('Asia/Taipei'))).toBe(true)
  })

  it('reports the runtime zone and validates zones', () => {
    const zone = getBrowserTimeZone()
    expect(isValidTimeZone(zone)).toBe(true)
    // Follows the runtime zone (e.g. the TZ env var these tests are run under).
    expect(zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(isValidTimeZone('Asia/Taipei')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('local Date bridge (date pickers)', () => {
  it('round-trips through local midnight in the current zone', () => {
    const dates = [
      ...eachDay('2024-01-01', '2027-12-31'),
      '0050-06-15',
      '1900-01-01',
      '1969-12-31',
      '2018-11-04', // midnight DST gap in America/Sao_Paulo
      '9999-12-31',
    ]
    for (const date of dates) {
      const local = toLocalDate(date)
      const { year, month, day } = parseISODate(date)
      expect(local.getFullYear()).toBe(year)
      expect(local.getMonth()).toBe(month - 1)
      expect(local.getDate()).toBe(day)
      expect(local.getHours()).toBeLessThanOrEqual(1) // 01:00 only where midnight does not exist
      expect(fromLocalDate(local)).toBe(date)
    }
  })

  it('reads the local calendar day of any time of day', () => {
    expect(fromLocalDate(new Date(2026, 10, 2, 23, 59, 59))).toBe('2026-11-02')
    expect(fromLocalDate(new Date(2026, 10, 2, 0, 0, 0))).toBe('2026-11-02')
    expect(() => fromLocalDate(new Date(Number.NaN))).toThrow(RangeError)
  })
})

describe('formatting', () => {
  const styles: Array<[DateFormatStyle, string]> = [
    ['short', 'Nov 2'],
    ['medium', 'Nov 2, 2026'],
    ['long', 'Monday, November 2, 2026'],
    ['weekday', 'Mon'],
    ['weekdayNarrow', 'M'],
    ['month', 'Nov'],
    ['monthLong', 'November'],
    ['monthYear', 'November 2026'],
    ['shortMonthYear', 'Nov 2026'],
    ['day', '2'],
    ['year', '2026'],
  ]
  it.each(styles)('formatDate(2026-11-02, %s) = %s', (style, expected) => {
    expect(formatDate('2026-11-02', style)).toBe(expected)
  })

  it('never drifts around midnight or year boundaries', () => {
    expect(formatDate('2026-12-31', 'medium')).toBe('Dec 31, 2026')
    expect(formatDate('2027-01-01', 'medium')).toBe('Jan 1, 2027')
    expect(formatDate('2027-01-01', 'long')).toBe('Friday, January 1, 2027')
    expect(formatDate('2024-02-29', 'long')).toBe('Thursday, February 29, 2024')
    expect(formatDate('1969-12-31', 'medium')).toBe('Dec 31, 1969')
    expect(formatDate('0001-01-01', 'medium')).toBe('Jan 1, 1')
  })

  it('supports other locales and falls back for invalid ones', () => {
    expect(formatDate('2026-11-02', 'short', 'zh-TW')).toBe('11月2日')
    expect(formatDate('2026-11-02', 'medium', 'en-GB')).toBe('2 Nov 2026')
    expect(formatDate('2026-11-02', 'short', 'not a locale!')).toBe('Nov 2')
  })

  it('formatDateSmart', () => {
    const today = '2026-11-02'
    expect(formatDateSmart('2026-11-02', today)).toBe('Today')
    expect(formatDateSmart('2026-11-03', today)).toBe('Tomorrow')
    expect(formatDateSmart('2026-11-01', today)).toBe('Yesterday')
    expect(formatDateSmart('2026-11-05', today)).toBe('Nov 5')
    expect(formatDateSmart('2026-01-05', today)).toBe('Jan 5')
    expect(formatDateSmart('2027-01-03', today)).toBe('Jan 3, 2027')
    expect(formatDateSmart('2025-12-31', today)).toBe('Dec 31, 2025')
    expect(formatDateSmart('2027-01-01', '2026-12-31')).toBe('Tomorrow')
    expect(formatDateSmart('2026-12-31', '2027-01-01')).toBe('Yesterday')
  })

  it('formatDateRange', () => {
    const today = '2026-11-01'
    expect(formatDateRange(null, null)).toBe('')
    expect(formatDateRange(null, null, today)).toBe('')
    expect(formatDateRange('2026-11-02', '2026-11-05', today)).toBe('Nov 2 – Nov 5')
    expect(formatDateRange('2026-11-02', '2027-01-03', today)).toBe('Nov 2 – Jan 3, 2027')
    expect(formatDateRange('2027-01-03', '2027-01-05', today)).toBe('Jan 3 – Jan 5, 2027')
    expect(formatDateRange('2025-12-30', '2026-01-02', today)).toBe('Dec 30, 2025 – Jan 2')
    expect(formatDateRange('2026-11-02', '2026-11-02', today)).toBe('Nov 2')
    expect(formatDateRange(null, '2026-11-05', today)).toBe('Due Nov 5')
    expect(formatDateRange('2026-11-02', null, today)).toBe('Starts Nov 2')
    expect(formatDateRange('2027-01-03', null, today)).toBe('Starts Jan 3, 2027')
    expect(formatDateRange(null, '2025-12-31', today)).toBe('Due Dec 31, 2025')
    // Without `today`, the range's own first year is the reference.
    expect(formatDateRange('2026-11-02', '2027-01-03')).toBe('Nov 2 – Jan 3, 2027')
    expect(formatDateRange('2027-01-03', '2027-01-05')).toBe('Jan 3 – Jan 5')
    expect(formatDateRange(null, '2027-01-03')).toBe('Due Jan 3')
  })
})
