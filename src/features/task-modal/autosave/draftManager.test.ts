/**
 * The draft registry: drafts outlive the form, survive a reload of this tab, and never cross into
 * another account or over newer data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStorage } from '@/data/localRepository'
import type { Result, TaskPatch } from '@/domain/types'
import {
  DraftManager,
  DRAFTS_STORAGE_KEY,
  type DraftManagerEnv,
  type DraftSummary,
} from './draftManager'

const NETWORK: Result = { ok: false, error: { kind: 'network', message: 'Network error' } }

interface StubTask {
  title: string
  description: string | null
}

function setup(seed: Record<string, StubTask> = { t1: { title: 'Plan', description: 'old' } }) {
  const storage = createMemoryStorage()
  const state = {
    tasks: seed,
    ready: true,
    writes: [] as { taskId: string; patch: TaskPatch }[],
    next: { ok: true, value: undefined } as Result,
    recovered: [] as (readonly DraftSummary[])[],
    withdrawn: [] as string[],
  }
  const env: DraftManagerEnv = {
    readTask: (id) => (Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined),
    isReady: () => state.ready,
    write: async (taskId, patch) => {
      state.writes.push({ taskId, patch })
      if (state.next.ok && Object.hasOwn(state.tasks, taskId)) {
        state.tasks[taskId] = { ...state.tasks[taskId], ...(patch as Partial<StubTask>) }
      }
      return state.next
    },
    withdrawFailure: (taskId, field) => state.withdrawn.push(`${taskId}|${field}`),
    isOffline: () => false,
    storage: () => storage,
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onRecovered: (drafts) => state.recovered.push(drafts),
  }
  const manager = new DraftManager(env)
  manager.setScope('user-a')
  /** The same tab after a reload: a new manager over the same storage. */
  const reload = (scope = 'user-a') => {
    const next = new DraftManager(env)
    next.setScope(scope)
    return next
  }
  return { manager, state, storage, reload, env }
}

const flushMicrotasks = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Types into a field through a "form", then closes that form. */
function typeAndClose(manager: DraftManager, taskId: string, text: string) {
  const draft = manager.get(taskId, 'description')
  manager.attach(taskId, 'description', draft)
  draft.focus()
  draft.input(text)
  return () => manager.detach(taskId, 'description', draft)
}

describe('lifetime', () => {
  it('releases a draft once its job is done', async () => {
    const { manager, state } = setup()
    const close = typeAndClose(manager, 't1', 'new')
    close()
    await flushMicrotasks()
    expect(state.writes).toEqual([{ taskId: 't1', patch: { description: 'new' } }])
    expect(manager.getOutstanding()).toEqual([])
    expect(manager.hasUnsavedText()).toBe(false)
  })

  it('a failure after the form closed stays listed, with the text and the task', async () => {
    const { manager, state } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'new')()
    await flushMicrotasks()
    expect(manager.getOutstanding()).toMatchObject([
      { taskId: 't1', field: 'description', phase: 'failed', text: 'new', taskTitle: 'Plan' },
    ])
    expect(manager.hasUnsavedText()).toBe(true)
  })

  it('reopening the task finds the same text', async () => {
    const { manager, state } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'new')()
    await flushMicrotasks()
    expect(manager.get('t1', 'description').getSnapshot()).toMatchObject({
      text: 'new',
      phase: 'failed',
    })
  })

  it('Strict Mode (attach, detach, attach) keeps one live draft', () => {
    const { manager } = setup()
    const draft = manager.get('t1', 'title')
    manager.attach('t1', 'title', draft)
    manager.detach('t1', 'title', draft)
    manager.attach('t1', 'title', draft)
    expect(manager.get('t1', 'title')).toBe(draft)
  })

  it('a draft attached again after a detach still saves (Strict Mode, the real app)', () => {
    const { manager, state } = setup()
    const draft = manager.get('t1', 'title')
    manager.attach('t1', 'title', draft)
    manager.detach('t1', 'title', draft)
    manager.attach('t1', 'title', draft)
    draft.focus()
    draft.input('Plan B')
    expect(draft.commit()).toBe('sent')
    expect(state.writes).toEqual([{ taskId: 't1', patch: { title: 'Plan B' } }])
  })

  it('discardTask drops the text of a task being deleted', async () => {
    const { manager, state } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'new')()
    await flushMicrotasks()
    manager.discardTask('t1')
    expect(manager.getOutstanding()).toEqual([])
    expect(state.withdrawn).toEqual(['t1|description'])
  })

  it('flushAll sends what is unsent', () => {
    const { manager, state } = setup()
    const draft = manager.get('t1', 'title')
    manager.attach('t1', 'title', draft)
    draft.focus()
    draft.input('Plan B')
    manager.flushAll()
    expect(state.writes).toEqual([{ taskId: 't1', patch: { title: 'Plan B' } }])
  })
})

describe('sessionStorage', () => {
  it('keeps unsent text while typing and clears it once stored', async () => {
    const { manager, storage } = setup()
    const close = typeAndClose(manager, 't1', 'new')
    expect(JSON.parse(storage.getItem(DRAFTS_STORAGE_KEY) ?? '{}')).toMatchObject({
      scope: 'user-a',
      drafts: [{ taskId: 't1', field: 'description', value: 'new', base: 'old' }],
    })
    close()
    await flushMicrotasks()
    expect(storage.getItem(DRAFTS_STORAGE_KEY)).toBeNull()
  })

  it('a reload restores failed text without writing anything', async () => {
    const { manager, state, reload } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'new')()
    await flushMicrotasks()
    expect(state.writes).toHaveLength(1)

    const next = reload()
    expect(state.writes).toHaveLength(1)
    expect(next.getOutstanding()).toMatchObject([
      { taskId: 't1', field: 'description', phase: 'restored', text: 'new' },
    ])
    expect(state.recovered).toHaveLength(1)
  })

  it('waits for the workspace before judging recovered text', async () => {
    const { manager, state, reload } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'new')()
    await flushMicrotasks()

    state.ready = false
    const next = reload()
    expect(state.recovered).toHaveLength(0)
    state.ready = true
    next.storeChanged()
    expect(state.recovered).toHaveLength(1)
    // Reported once.
    next.storeChanged()
    expect(state.recovered).toHaveLength(1)
  })

  it('text that reached the server after all is dropped, not offered', async () => {
    const { manager, state, reload, storage } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'new')()
    await flushMicrotasks()

    state.tasks.t1 = { ...state.tasks.t1, description: 'new' }
    const next = reload()
    expect(next.getOutstanding()).toEqual([])
    expect(next.hasUnsavedText()).toBe(false)
    expect(storage.getItem(DRAFTS_STORAGE_KEY)).toBeNull()
  })

  it('never puts old text over newer data: it becomes a conflict', async () => {
    const { manager, state, reload } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'new')()
    await flushMicrotasks()

    state.tasks.t1 = { ...state.tasks.t1, description: 'changed elsewhere' }
    const next = reload()
    expect(next.getOutstanding()).toMatchObject([{ phase: 'conflict', text: 'new' }])
    expect(next.get('t1', 'description').getSnapshot().text).toBeNull()
  })

  it('text whose task is gone is listed so it can still be copied', async () => {
    const { manager, state, reload } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'new')()
    await flushMicrotasks()

    state.tasks = {}
    const next = reload()
    expect(next.getOutstanding()).toMatchObject([
      { taskExists: false, taskTitle: 'Plan', text: 'new' },
    ])
  })

  it('unreadable storage is ignored', () => {
    const { storage, reload } = setup()
    for (const bad of [
      'not json',
      '{"version":2,"scope":"user-a","drafts":[]}',
      '{"version":1,"scope":"user-a","drafts":"x"}',
      '{"version":1,"scope":"user-a","drafts":[{"taskId":1}]}',
    ]) {
      storage.setItem(DRAFTS_STORAGE_KEY, bad)
      expect(reload().getOutstanding()).toEqual([])
    }
  })

  it('storage that refuses writes costs only the reload safety net', () => {
    const { manager, storage } = setup()
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const draft = manager.get('t1', 'description')
    manager.attach('t1', 'description', draft)
    draft.focus()
    expect(() => draft.input('new')).not.toThrow()
    expect(draft.getSnapshot().text).toBe('new')
  })
})

describe('accounts', () => {
  it("another account never sees the text, and the old account's copy is removed", async () => {
    const { manager, state, storage, reload } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'private text')()
    await flushMicrotasks()

    const other = reload('user-b')
    expect(other.getOutstanding()).toEqual([])
    expect(storage.getItem(DRAFTS_STORAGE_KEY)).toBeNull()
  })

  it('switching accounts in the same page clears memory, then storage on the next sign-in', async () => {
    const { manager, state, storage } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'private text')()
    await flushMicrotasks()

    manager.setScope(null)
    expect(manager.getOutstanding()).toEqual([])
    // An expired session: still there for the same account…
    expect(storage.getItem(DRAFTS_STORAGE_KEY)).not.toBeNull()
    // …and gone as soon as someone else signs in.
    manager.setScope('user-b')
    expect(manager.getOutstanding()).toEqual([])
    expect(storage.getItem(DRAFTS_STORAGE_KEY)).toBeNull()
  })

  it('the same account signing back in gets its text back', async () => {
    const { manager, state } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'mine')()
    await flushMicrotasks()

    manager.setScope(null)
    manager.setScope('user-a')
    expect(manager.getOutstanding()).toMatchObject([{ text: 'mine', phase: 'restored' }])
  })

  it('signing out on purpose removes the stored copy', async () => {
    const { manager, state, storage } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'mine')()
    await flushMicrotasks()

    manager.setScope(null)
    manager.purgeStored()
    expect(storage.getItem(DRAFTS_STORAGE_KEY)).toBeNull()
  })

  it('an answer arriving after sign-out changes nothing', async () => {
    const { manager, state, storage } = setup()
    state.next = NETWORK
    typeAndClose(manager, 't1', 'mine')()
    manager.setScope(null)
    await flushMicrotasks()
    expect(manager.getOutstanding()).toEqual([])
    expect(storage.getItem(DRAFTS_STORAGE_KEY)).not.toContain('"phase"')
  })
})
