import { describe, expect, it } from 'vitest'
import type { SyncState } from '@/data/contracts'
import { deriveSyncStatus } from './syncStatus'

const idle: SyncState = {
  pending: 0,
  lastError: null,
  lastSavedAt: null,
  lastLoadedAt: 1,
  online: true,
  canRetry: false,
}
const failure = { kind: 'network' as const, message: 'Network error — check your connection.' }

describe('deriveSyncStatus', () => {
  it('always says "Local only — not synced" in local mode when idle (never pretends to sync)', () => {
    expect(deriveSyncStatus('local', idle)).toMatchObject({
      kind: 'local',
      label: 'Local only — not synced',
    })
    expect(deriveSyncStatus('local', { ...idle, online: false }).kind).toBe('local')
  })

  it('shows saving while writes are pending', () => {
    expect(deriveSyncStatus('supabase', { ...idle, pending: 2 }).label).toBe('Saving…')
    expect(deriveSyncStatus('local', { ...idle, pending: 1 }).label).toBe('Saving…')
  })

  it('offers Retry for a failed write', () => {
    const status = deriveSyncStatus('supabase', { ...idle, lastError: failure, canRetry: true })
    expect(status).toMatchObject({ kind: 'failed', label: "Couldn't save", canRetry: true })
    expect(status.detail).toContain(failure.message)
    expect(deriveSyncStatus('local', { ...idle, lastError: failure, canRetry: true }).kind).toBe(
      'failed',
    )
  })

  it('reports offline in cloud mode', () => {
    expect(deriveSyncStatus('supabase', { ...idle, online: false })).toMatchObject({
      kind: 'offline',
      label: 'Offline',
    })
  })

  it('says "Saved" when the cloud is in sync, and flags non-retryable refresh errors', () => {
    expect(deriveSyncStatus('supabase', idle)).toMatchObject({ kind: 'saved', label: 'Saved' })
    expect(deriveSyncStatus('supabase', { ...idle, lastError: failure }).kind).toBe('stale')
  })
})
