/**
 * Per-device Gantt prefs: the outline pane's hidden flag parses strictly (only `true` hides it),
 * persists, and never touches the stored pane width.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { reloadGanttPrefsForTests, useOutlineCollapsed, usePaneWidth } from './ganttPrefs'
import { PANE_WIDTH_DEFAULT } from './model/constants'

const OUTLINE_KEY = 'cairn:gantt-outline-collapsed'
const PANE_KEY = 'cairn:gantt-pane-width'

function hiddenWith(raw: string | null): boolean {
  localStorage.clear()
  if (raw !== null) localStorage.setItem(OUTLINE_KEY, raw)
  reloadGanttPrefsForTests()
  return renderHook(() => useOutlineCollapsed()).result.current[0]
}

beforeEach(() => {
  localStorage.clear()
  reloadGanttPrefsForTests()
})

describe('useOutlineCollapsed', () => {
  it('shows the pane by default and when nothing is stored', () => {
    expect(hiddenWith(null)).toBe(false)
  })

  it('only a stored true hides the pane', () => {
    expect(hiddenWith('true')).toBe(true)
    expect(hiddenWith('false')).toBe(false)
  })

  it.each(['"true"', '1', '0', 'null', '{}', '[true]', 'not json', ''])(
    'treats %j as shown',
    (raw) => {
      expect(hiddenWith(raw)).toBe(false)
    },
  )

  it('persists a change and picks it up after a reload', () => {
    const { result } = renderHook(() => useOutlineCollapsed())
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(localStorage.getItem(OUTLINE_KEY)).toBe('true')
    reloadGanttPrefsForTests()
    expect(renderHook(() => useOutlineCollapsed()).result.current[0]).toBe(true)
    act(() => result.current[1](false))
    expect(localStorage.getItem(OUTLINE_KEY)).toBe('false')
  })

  it('leaves the stored pane width alone', () => {
    localStorage.setItem(PANE_KEY, '340')
    reloadGanttPrefsForTests()
    const outline = renderHook(() => useOutlineCollapsed())
    const pane = renderHook(() => usePaneWidth())
    expect(pane.result.current[0]).toBe(340)
    act(() => outline.result.current[1](true))
    expect(pane.result.current[0]).toBe(340)
    expect(localStorage.getItem(PANE_KEY)).toBe('340')
    act(() => outline.result.current[1](false))
    expect(pane.result.current[0]).toBe(340)
    expect(localStorage.getItem(PANE_KEY)).toBe('340')
  })

  it('never writes the pane width key when the pane is hidden before any resize', () => {
    const outline = renderHook(() => useOutlineCollapsed())
    const pane = renderHook(() => usePaneWidth())
    act(() => outline.result.current[1](true))
    expect(localStorage.getItem(PANE_KEY)).toBeNull()
    expect(pane.result.current[0]).toBe(PANE_WIDTH_DEFAULT)
  })
})
