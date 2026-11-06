import { describe, expect, it } from 'vitest'
import { safeReturnPath } from './loginRedirect'

const ORIGIN = 'https://cairn.example'

describe('safeReturnPath', () => {
  it('keeps same-app paths with their query and hash', () => {
    expect(safeReturnPath('/projects/p1/gantt?task=t1#today', ORIGIN)).toBe(
      '/projects/p1/gantt?task=t1#today',
    )
    expect(safeReturnPath('/login-help', ORIGIN)).toBe('/login-help')
  })

  it('falls back to /overview for missing, foreign or looping targets', () => {
    for (const from of [
      undefined,
      '',
      'overview',
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      '/.//evil.example',
      '/x/..//evil.example',
      '/login',
      '/login?next=/x',
      '/login/',
    ]) {
      expect(safeReturnPath(from, ORIGIN), String(from)).toBe('/overview')
    }
  })
})
