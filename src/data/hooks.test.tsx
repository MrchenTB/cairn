import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
  makeWorkspace,
} from '@/domain/testFactories'
import type { SyncState } from './contracts'
import { DEFAULT_PREFERENCES, EMPTY_WORKSPACE } from './defaults'
import {
  syncIndicator,
  useAuth,
  useMilestone,
  useMilestones,
  usePhase,
  useProject,
  useProjects,
  useSyncIndicator,
  useTask,
  useToday,
} from './hooks'
import { useAuthStore, useWorkspaceStore } from './store'

beforeEach(() => {
  useWorkspaceStore.setState({
    data: EMPTY_WORKSPACE,
    preferences: { ...DEFAULT_PREFERENCES, timezone: 'Asia/Taipei' },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useToday', () => {
  it('rolls over at midnight in the configured time zone and follows time zone changes', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T15:59:50Z') }) // 23:59:50 in Taipei
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useToday()
    })
    expect(result.current).toBe('2026-11-02')
    const rendersBefore = renders
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(result.current).toBe('2026-11-03')
    expect(renders).toBe(rendersBefore + 1)

    act(() => {
      vi.advanceTimersByTime(30_000) // same day: no re-render
    })
    expect(renders).toBe(rendersBefore + 1)

    act(() => {
      useWorkspaceStore.setState((state) => ({
        preferences: { ...state.preferences, timezone: 'America/Los_Angeles' },
      }))
    })
    expect(result.current).toBe('2026-11-02')
  })
})

describe('selectors', () => {
  it('useProjects is sorted, hides archived projects and keeps its reference while data is unchanged', () => {
    useWorkspaceStore.setState({
      data: makeWorkspace({
        projects: [
          makeProject({ id: 'b', sortOrder: 'a1' }),
          makeProject({ id: 'a', sortOrder: 'a0' }),
          makeProject({ id: 'z', sortOrder: 'a2', status: 'archived' }),
        ],
        phases: [makePhase({ id: 'ph', projectId: 'a' })],
      }),
    })
    const { result, rerender } = renderHook(() => useProjects())
    const first = result.current
    expect(first.map((p) => p.id)).toEqual(['a', 'b'])
    rerender()
    expect(result.current).toBe(first)
    const { result: all } = renderHook(() => useProjects({ includeArchived: true }))
    expect(all.current.map((p) => p.id)).toEqual(['a', 'b', 'z'])
    const { result: phase } = renderHook(() => usePhase('ph'))
    expect(phase.current?.projectId).toBe('a')
  })
})

describe('lookups by id', () => {
  it('ignore inherited keys (ids come from the URL, e.g. ?task=constructor)', () => {
    useWorkspaceStore.setState({
      data: makeWorkspace({
        projects: [makeProject({ id: 'p1' })],
        tasks: [makeTask({ id: 't1', projectId: 'p1' })],
      }),
    })
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(renderHook(() => useTask(id)).result.current).toBeUndefined()
      expect(renderHook(() => useProject(id)).result.current).toBeUndefined()
      expect(renderHook(() => usePhase(id)).result.current).toBeUndefined()
      expect(renderHook(() => useMilestone(id)).result.current).toBeUndefined()
    }
    expect(renderHook(() => useTask('t1')).result.current?.id).toBe('t1')
  })

  it('useMilestones orders like the outline: date, then name (numeric), then id', () => {
    useWorkspaceStore.setState({
      data: makeWorkspace({
        milestones: [
          makeMilestone({ id: 'm3', projectId: 'p1', name: 'Phase 10', date: '2026-11-02' }),
          makeMilestone({ id: 'm2', projectId: 'p1', name: 'Phase 9', date: '2026-11-02' }),
          makeMilestone({ id: 'm1', projectId: 'p1', name: 'Kickoff', date: '2026-11-01' }),
        ],
      }),
    })
    const { result } = renderHook(() => useMilestones('p1'))
    expect(result.current.map((m) => m.name)).toEqual(['Kickoff', 'Phase 9', 'Phase 10'])
  })
})

describe('sync indicator', () => {
  const sync: SyncState = {
    pending: 0,
    lastError: null,
    lastSavedAt: null,
    lastLoadedAt: null,
    online: true,
    canRetry: false,
  }
  const error = { kind: 'network' as const, message: 'offline' }

  it('prioritises error → offline → saving → local → saved → idle', () => {
    expect(syncIndicator('supabase', sync)).toBe('idle')
    expect(syncIndicator('supabase', { ...sync, lastSavedAt: 1 })).toBe('saved')
    expect(syncIndicator('supabase', { ...sync, pending: 2, lastSavedAt: 1 })).toBe('saving')
    expect(syncIndicator('supabase', { ...sync, online: false, pending: 1 })).toBe('offline')
    expect(syncIndicator('supabase', { ...sync, online: false, lastError: error })).toBe('error')
    expect(syncIndicator('local', sync)).toBe('local')
    expect(syncIndicator('local', { ...sync, online: false })).toBe('local')
    expect(syncIndicator('local', { ...sync, pending: 1 })).toBe('saving')
    expect(syncIndicator('local', { ...sync, lastError: error })).toBe('error')
  })

  it('useSyncIndicator reads the store', () => {
    useWorkspaceStore.setState({ sync: { ...sync, lastError: error, canRetry: true } })
    const { result } = renderHook(() => useSyncIndicator())
    expect(result.current).toEqual({ indicator: 'error', canRetry: true })
  })
})

describe('useAuth', () => {
  it('exposes passwordRecovery (the "Set a new password" dialog reads it)', () => {
    const initial = useAuthStore.getState()
    const { result } = renderHook(() => useAuth())
    expect(result.current).toMatchObject({ passwordRecovery: false, mode: initial.mode })
    act(() => useAuthStore.setState({ passwordRecovery: true }))
    expect(result.current.passwordRecovery).toBe(true)
    act(() => useAuthStore.setState(initial, true))
  })
})

describe('useToday clock', () => {
  it('every due label shares one timer, stopped when the last one unmounts', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T03:00:00Z') })
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval')
    const hooks = Array.from({ length: 50 }, () => renderHook(() => useToday()))
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    for (const hook of hooks) hook.unmount()
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('a tab shown again (e.g. the next morning) re-checks the date at once', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T15:59:59Z') }) // 23:59:59 in Taipei
    const { result } = renderHook(() => useToday())
    expect(result.current).toBe('2026-11-02')
    vi.setSystemTime(new Date('2026-11-03T00:30:00Z')) // timers were asleep (laptop closed)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).toBe('2026-11-03')
  })
})
