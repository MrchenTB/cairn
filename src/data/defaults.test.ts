import { describe, expect, it } from 'vitest'
import { isValidTimeZone } from '@/domain/dates'
import { DEFAULT_PREFERENCES, FALLBACK_TIME_ZONE, initialTimeZone } from './defaults'

describe('initial time zone (saved on first run so every device agrees on "today")', () => {
  it("is the browser's zone when it is a real IANA zone", () => {
    expect(initialTimeZone('Europe/Paris')).toBe('Europe/Paris')
    expect(initialTimeZone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires')
  })

  it('falls back to Asia/Taipei for zones the runtime cannot use', () => {
    // Chrome reports "Etc/Unknown" when the OS zone is not one ICU knows.
    for (const candidate of ['Etc/Unknown', '', null, 'Mars/Olympus_Mons', 42]) {
      expect(initialTimeZone(candidate)).toBe(FALLBACK_TIME_ZONE)
    }
    expect(FALLBACK_TIME_ZONE).toBe('Asia/Taipei')
  })

  it('the defaults always carry a usable zone', () => {
    expect(isValidTimeZone(DEFAULT_PREFERENCES.timezone)).toBe(true)
  })
})
