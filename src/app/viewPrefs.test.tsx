import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  forgetProject,
  getGanttScale,
  getProjectView,
  getRecentProjectIds,
  recordProjectVisit,
  reloadViewPrefsForTests,
  setGanttScale,
  setProjectView,
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
