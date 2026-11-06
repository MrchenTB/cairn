import { describe, expect, it } from 'vitest'
import {
  describeTimeZone,
  filterTimeZones,
  formatOffset,
  listTimeZones,
  offsetMinutesAt,
} from './timezones'

// 2026-11-02: US daylight saving ended on Nov 1, Europe's on Oct 25.
const NOV = new Date('2026-11-02T12:00:00Z')
const JULY = new Date('2026-07-02T12:00:00Z')

describe('offsets', () => {
  it('reads the current UTC offset of a zone, daylight saving included', () => {
    expect(offsetMinutesAt('Asia/Taipei', NOV)).toBe(480)
    expect(offsetMinutesAt('Asia/Kolkata', NOV)).toBe(330) // valid in every engine, listed or not
    expect(offsetMinutesAt('America/New_York', NOV)).toBe(-300)
    expect(offsetMinutesAt('America/New_York', JULY)).toBe(-240)
    expect(offsetMinutesAt('UTC', NOV)).toBe(0)
  })

  it('formats offsets as UTC±hh:mm', () => {
    expect(formatOffset(480)).toBe('UTC+08:00')
    expect(formatOffset(-210)).toBe('UTC-03:30')
    expect(formatOffset(0)).toBe('UTC+00:00')
    expect(formatOffset(345)).toBe('UTC+05:45')
  })
})

describe('listTimeZones', () => {
  const zones = listTimeZones(NOV, ['Mars/Olympus', 'Europe/Berlin'])
  const byId = (id: string) => zones.find((zone) => zone.id === id)

  it('lists the runtime zones plus UTC and valid extras, ordered by offset then id', () => {
    expect(byId('Asia/Taipei')?.offset).toBe('UTC+08:00')
    expect(byId('UTC')?.offset).toBe('UTC+00:00')
    expect(byId('Europe/Berlin')).toBeDefined()
    expect(byId('Mars/Olympus')).toBeUndefined() // invalid ids are dropped
    for (let i = 1; i < zones.length; i += 1) {
      expect(zones[i - 1].offsetMinutes).toBeLessThanOrEqual(zones[i].offsetMinutes)
    }
    expect(new Set(zones.map((zone) => zone.id)).size).toBe(zones.length)
  })

  it('describes a single zone the same way', () => {
    expect(describeTimeZone('America/New_York', NOV)).toMatchObject({
      id: 'America/New_York',
      name: 'America/New York',
      offset: 'UTC-05:00',
    })
  })

  it('filters by city, region or offset in any common spelling', () => {
    const ids = (query: string) => filterTimeZones(zones, query).map((zone) => zone.id)
    expect(ids('taipei')).toEqual(['Asia/Taipei'])
    expect(ids('new york')).toEqual(['America/New_York'])
    expect(ids('NEW_YORK')).toEqual(['America/New_York']) // the raw IANA spelling works too
    expect(ids('utc+8')).toContain('Asia/Taipei')
    expect(ids('gmt+08:00')).toContain('Asia/Taipei')
    // Engines disagree on 'Asia/Kolkata' vs 'Asia/Calcutta': assert on the offset instead.
    const half = filterTimeZones(zones, '+5:30')
    expect(half.length).toBeGreaterThan(0)
    expect(half.every((zone) => zone.offsetMinutes === 330)).toBe(true)
    expect(ids('asia taipei')).toEqual(['Asia/Taipei'])
    expect(ids('zzzz')).toEqual([])
    expect(ids('   ')).toHaveLength(zones.length)
  })
})
