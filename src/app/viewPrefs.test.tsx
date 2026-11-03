import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forgetProject,
  getGanttScale,
  getProjectView,
  getRecentProjectIds,
  recordProjectVisit,
  reloadViewPrefsForTests,
  setGanttScale,
  setProjectView,
  useProjectView,
  useRecentProjectIds,
} from './viewPrefs'

beforeEach(() => {
  localStorage.clear()
  reloadViewPrefsForTests()
})

describe('view prefs', () => {
  it('remembers the last view per project (default list) and persists it', () => {
    expect(getProjectView('p1')).toBe('list')
    setProjectView('p1', 'gantt')
    expect(getProjectView('p1')).toBe('gantt')
    expect(getProjectView('p2')).toBe('list')
    reloadViewPrefsForTests()
    expect(getProjectView('p1')).toBe('gantt')
  })

  it('remembers the Gantt scale per scope (default week)', () => {
    expect(getGanttScale('timeline')).toBe('week')
    setGanttScale('timeline', 'month')
    setGanttScale('p1', 'day')
    reloadViewPrefsForTests()
    expect(getGanttScale('timeline')).toBe('month')
    expect(getGanttScale('p1')).toBe('day')
  })

  it('keeps recent projects most-recent-first, de-duplicated and capped', () => {
    for (let i = 1; i <= 12; i++) recordProjectVisit(`p${i}`)
    recordProjectVisit('p5')
    const recents = getRecentProjectIds()
    expect(recents[0]).toBe('p5')
    expect(recents).toHaveLength(10)
    expect(new Set(recents).size).toBe(10)
    forgetProject('p5')
    expect(getRecentProjectIds()).not.toContain('p5')
  })

  it('notifies subscribers', () => {
    const { result } = renderHook(() => useRecentProjectIds())
    expect(result.current).toEqual([])
    act(() => recordProjectVisit('a'))
    act(() => recordProjectVisit('b'))
    expect(result.current).toEqual(['b', 'a'])
  })

  it('keeps working in memory when localStorage reads and writes throw', () => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied)
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    try {
      reloadViewPrefsForTests()
      expect(getProjectView('p1')).toBe('list')
      expect(() => setProjectView('p1', 'board')).not.toThrow()
      expect(getProjectView('p1')).toBe('board')
      expect(() => setGanttScale('p1', 'month')).not.toThrow()
      expect(getGanttScale('p1')).toBe('month')
      expect(() => recordProjectVisit('p1')).not.toThrow()
      expect(getRecentProjectIds()).toEqual(['p1'])
      const { result } = renderHook(() => useProjectView('p1'))
      expect(result.current).toBe('board')
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })

  it('survives a localStorage getter that throws (storage disabled by the browser)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied.', 'SecurityError')
      },
    })
    try {
      reloadViewPrefsForTests()
      expect(getGanttScale('timeline')).toBe('week')
      setGanttScale('timeline', 'day')
      expect(getGanttScale('timeline')).toBe('day')
      forgetProject('p1')
      expect(getRecentProjectIds()).toEqual([])
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor)
      else Reflect.deleteProperty(window, 'localStorage')
    }
  })

  it('never reads inherited properties as stored values', () => {
    expect(getProjectView('constructor')).toBe('list')
    expect(getGanttScale('toString')).toBe('week')
    localStorage.setItem('cairn:project-views', '{"__proto__":"gantt","p1":"board"}')
    reloadViewPrefsForTests()
    expect(getProjectView('__proto__')).toBe('list')
    expect(getProjectView('p1')).toBe('board')
  })

  it('ignores corrupted or invalid stored values', () => {
    localStorage.setItem('cairn:project-views', '{not json')
    localStorage.setItem('cairn:gantt-scales', JSON.stringify({ p1: 'decade' }))
    localStorage.setItem('cairn:recent-projects', JSON.stringify([1, null, 'ok']))
    reloadViewPrefsForTests()
    expect(getProjectView('p1')).toBe('list')
    expect(getGanttScale('p1')).toBe('week')
    expect(getRecentProjectIds()).toEqual(['ok'])
  })
})
