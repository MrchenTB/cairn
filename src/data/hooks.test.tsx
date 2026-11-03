import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePhase, makeProject, makeWorkspace } from '@/domain/testFactories'
import type { SyncState } from './contracts'
import { DEFAULT_PREFERENCES, EMPTY_WORKSPACE } from './defaults'
import { syncIndicator, usePhase, useProjects, useSyncIndicator, useToday } from './hooks'
import { useWorkspaceStore } from './store'

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
