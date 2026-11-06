import { afterAll, describe, expect, it } from 'vitest'
import { addDays, diffDays, eachDay, fromLocalDate, toLocalDate, todayInTimeZone } from './dates'

const ZONES = [
  'Asia/Taipei',
  'America/Los_Angeles',
  'America/New_York',
  'Pacific/Auckland',
  'UTC',
  'America/Sao_Paulo',
  'Asia/Beirut',
  'Pacific/Apia',
  'Pacific/Kiritimati',
]
declare const process: { env: Record<string, string | undefined> }
const originalTZ = process.env.TZ

afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ
  else process.env.TZ = originalTZ
})

describe('date picker conversion never shifts the chosen day, in any browser zone', () => {
  for (const zone of ZONES) {
    it(`${zone}: fromLocalDate(toLocalDate(d)) === d for 2026-2028 incl. leap day and DST days`, () => {
      process.env.TZ = zone
      for (const d of eachDay('2026-01-01', '2028-12-31')) {
        expect(fromLocalDate(toLocalDate(d))).toBe(d)
      }
    })
  }
})

describe('day arithmetic ignores DST and the browser zone', () => {
  for (const zone of ZONES) {
    it(`${zone}: addDays/diffDays are whole days across DST changes, month and year ends`, () => {
      process.env.TZ = zone
      expect(addDays('2026-03-07', 2)).toBe('2026-03-09')
      expect(addDays('2026-10-31', 2)).toBe('2026-11-02')
      expect(diffDays('2026-03-06', '2026-03-10')).toBe(4)
      expect(diffDays('2026-10-30', '2026-11-03')).toBe(4)
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
      expect(addDays('2028-02-29', 1)).toBe('2028-03-01')
      expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
      expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
      expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    })
  }
})

describe('todayInTimeZone follows the given zone, not the browser zone', () => {
  it('flips exactly at local midnight, incl. DST days', () => {
    process.env.TZ = 'America/Los_Angeles'
    expect(todayInTimeZone('Asia/Taipei', new Date('2026-11-04T15:59:59Z'))).toBe('2026-11-04')
    expect(todayInTimeZone('Asia/Taipei', new Date('2026-11-04T16:00:00Z'))).toBe('2026-11-05')
    expect(todayInTimeZone('Pacific/Auckland', new Date('2026-11-04T10:59:59Z'))).toBe('2026-11-04')
    expect(todayInTimeZone('Pacific/Auckland', new Date('2026-11-04T11:00:00Z'))).toBe('2026-11-05')
    // New York spring forward (2026-03-08 02:00 -> 03:00) and fall back (2026-11-01 02:00 -> 01:00)
    expect(todayInTimeZone('America/New_York', new Date('2026-03-08T04:59:59Z'))).toBe('2026-03-07')
    expect(todayInTimeZone('America/New_York', new Date('2026-03-08T05:00:00Z'))).toBe('2026-03-08')
    expect(todayInTimeZone('America/New_York', new Date('2026-03-09T03:59:59Z'))).toBe('2026-03-08')
    expect(todayInTimeZone('America/New_York', new Date('2026-03-09T04:00:00Z'))).toBe('2026-03-09')
    expect(todayInTimeZone('America/New_York', new Date('2026-11-02T04:59:59Z'))).toBe('2026-11-01')
    expect(todayInTimeZone('America/New_York', new Date('2026-11-02T05:00:00Z'))).toBe('2026-11-02')
    expect(todayInTimeZone('UTC', new Date('2028-02-29T23:59:59Z'))).toBe('2028-02-29')
    expect(todayInTimeZone('UTC', new Date('2028-03-01T00:00:00Z'))).toBe('2028-03-01')
    expect(todayInTimeZone('UTC', new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31')
    expect(todayInTimeZone('UTC', new Date('2027-01-01T00:00:00Z'))).toBe('2027-01-01')
  })

  it('handles half-hour and +14 offsets, the dateline and an invalid zone', () => {
    process.env.TZ = 'America/Los_Angeles'
    // Asia/Kolkata is UTC+5:30: midnight there is 18:30Z.
    expect(todayInTimeZone('Asia/Kolkata', new Date('2026-11-04T18:29:59Z'))).toBe('2026-11-04')
    expect(todayInTimeZone('Asia/Kolkata', new Date('2026-11-04T18:30:00Z'))).toBe('2026-11-05')
    // Pacific/Kiritimati UTC+14 and Pacific/Pago_Pago UTC-11 differ by two calendar days at the edges.
    const instant = new Date('2026-11-04T10:00:00Z')
    expect(todayInTimeZone('Pacific/Kiritimati', instant)).toBe('2026-11-05')
    expect(todayInTimeZone('Pacific/Pago_Pago', instant)).toBe('2026-11-03')
    // An invalid zone falls back to the browser zone (Los Angeles here), never throws.
    expect(todayInTimeZone('Not/AZone', new Date('2026-11-04T07:59:59Z'))).toBe('2026-11-03')
    expect(todayInTimeZone('Not/AZone', new Date('2026-11-04T08:00:00Z'))).toBe('2026-11-04')
  })
})
