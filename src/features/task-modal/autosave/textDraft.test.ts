/**
 * The rules of one text field's autosave: when it writes, what it keeps, and what an IME can never
 * cause. Fake clock; the store is a controllable stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Result } from '@/domain/types'
import { FIELD_RULES } from './draftManager'
import {
  DESCRIPTION_DEBOUNCE_MS,
  DESCRIPTION_MAX_WAIT_MS,
  TextDraft,
  type DraftRecord,
  type TextField,
} from './textDraft'

const NETWORK: Result = { ok: false, error: { kind: 'network', message: 'Network error' } }

/** A store stand-in: optimistic value, one answer per write, resolved by the test. */
function setup(field: TextField, initial: string | null, record?: DraftRecord) {
  const state = {
    saved: initial as string | null | undefined,
    offline: false,
    writes: [] as (string | null)[],
    withdrawn: 0,
    changes: 0,
    answers: [] as ((result?: Result) => void)[],
    autoAnswer: true,
  }
  const draft = new TextDraft(
    FIELD_RULES[field],
    {
      readSaved: () => state.saved,
      write: (value) => {
        const before = state.saved
        state.writes.push(value)
        state.saved = value // optimistic
        return new Promise<Result>((resolve) => {
          const answer = (result: Result = { ok: true, value: undefined }) => {
            if (!result.ok) state.saved = before // rollback
            resolve(result)
          }
          if (state.autoAnswer) answer()
          else state.answers.push(answer)
        })
      },
      withdrawFailure: () => {
        state.withdrawn += 1
      },
      isOffline: () => state.offline,
      now: () => Date.now(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onChange: () => {
        state.changes += 1
      },
    },
    record,
  )
  return { draft, state }
}

const flushMicrotasks = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('title: commit timing', () => {
  it('never writes while typing, only on commit (Enter) or blur', async () => {
    const { draft, state } = setup('title', 'Plan')
    draft.focus()
    draft.input('Plan v2')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.writes).toEqual([])
    expect(draft.phase).toBe('pending')

    expect(draft.commit()).toBe('sent')
    expect(state.writes).toEqual(['Plan v2'])
    await flushMicrotasks()
    // Still focused: the field keeps its text (no value swap under the caret).
    expect(draft.getSnapshot().text).toBe('Plan v2')
    expect(draft.phase).toBe('clean')

    draft.input('Plan v3')
    draft.blur()
    expect(state.writes).toEqual(['Plan v2', 'Plan v3'])
    await flushMicrotasks()
    // Lost focus and stored: back to following the store.
    expect(draft.getSnapshot().text).toBeNull()
    expect(draft.busy).toBe(false)
  })

  it('trims before comparing: extra spaces are not a change', () => {
    const { draft, state } = setup('title', 'Plan')
    draft.focus()
    draft.input('  Plan ')
    draft.blur()
    expect(state.writes).toEqual([])
    expect(draft.getSnapshot().text).toBeNull()
  })

  it('typing and undoing is not a change', () => {
    const { draft, state } = setup('title', 'Plan')
    draft.focus()
    draft.input('Plan!')
    draft.input('Plan')
    expect(draft.phase).toBe('clean')
    draft.blur()
    expect(state.writes).toEqual([])
  })
})

describe('title: empty and invalid text', () => {
  it('an empty title is never sent: commit puts the stored title back and says so', () => {
    const { draft, state } = setup('title', 'Plan')
    draft.focus()
    draft.input('   ')
    expect(draft.phase).toBe('invalid')
    expect(draft.getSnapshot().error).toBe('Task title is required.')

    expect(draft.commit()).toBe('reverted')
    expect(state.writes).toEqual([])
    expect(draft.getSnapshot()).toMatchObject({ text: null, revertedTo: 'Plan', phase: 'clean' })

    draft.input('Plan B')
    expect(draft.getSnapshot().revertedTo).toBeNull()
  })

  it('a tab switch never reverts an empty title (the user is still editing)', () => {
    const { draft, state } = setup('title', 'Plan')
    draft.focus()
    draft.input('')
    draft.blur({ windowOnly: true })
    expect(state.writes).toEqual([])
    expect(draft.getSnapshot().text).toBe('')
    expect(draft.phase).toBe('invalid')
  })

  it('a title over the limit is kept for fixing, and never sent', () => {
    const { draft, state } = setup('title', 'Plan')
    const tooLong = 'x'.repeat(501)
    draft.focus()
    draft.input(tooLong)
    expect(draft.commit()).toBe('invalid')
    draft.blur()
    expect(state.writes).toEqual([])
    expect(draft.getSnapshot()).toMatchObject({
      text: tooLong,
      phase: 'invalid',
      error: 'Task title must be at most 500 characters.',
    })
  })
})

describe('description: debounce, max-wait, coalescing', () => {
  it('waits for a pause; typing restarts the wait', async () => {
    const { draft, state } = setup('description', null)
    draft.focus()
    draft.input('a')
    await vi.advanceTimersByTimeAsync(DESCRIPTION_DEBOUNCE_MS - 1)
    expect(state.writes).toEqual([])
    draft.input('ab')
    await vi.advanceTimersByTimeAsync(DESCRIPTION_DEBOUNCE_MS - 1)
    expect(state.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(state.writes).toEqual(['ab'])
  })

  it('20 keystrokes then a pause are one write', async () => {
    const { draft, state } = setup('description', null)
    draft.focus()
    for (let i = 1; i <= 20; i++) {
      draft.input('x'.repeat(i))
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(DESCRIPTION_DEBOUNCE_MS)
    expect(state.writes).toEqual(['x'.repeat(20)])
  })

  it('typing without a pause still saves at max-wait', async () => {
    const { draft, state } = setup('description', null)
    draft.focus()
    const start = Date.now()
    let text = ''
    while (Date.now() - start < DESCRIPTION_MAX_WAIT_MS) {
      text += 'x'
      draft.input(text)
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(state.writes).toHaveLength(1)
    expect(state.writes[0]?.length).toBeGreaterThan(10)
  })

  it('blur saves right away and cancels the timer', async () => {
    const { draft, state } = setup('description', null)
    draft.focus()
    draft.input('note')
    draft.blur()
    expect(state.writes).toEqual(['note'])
    await vi.advanceTimersByTimeAsync(DESCRIPTION_DEBOUNCE_MS * 2)
    expect(state.writes).toEqual(['note'])
  })

  it('whitespace only is stored as null (and is no change when already empty)', async () => {
    const empty = setup('description', null)
    empty.draft.focus()
    empty.draft.input('  \n')
    empty.draft.blur()
    expect(empty.state.writes).toEqual([])

    const full = setup('description', 'old')
    full.draft.focus()
    full.draft.input('  \n')
    full.draft.blur()
    expect(full.state.writes).toEqual([null])
  })

  it('coalesces: while a write is in flight only the newest text follows', async () => {
    const { draft, state } = setup('description', null)
    state.autoAnswer = false
    draft.focus()
    draft.input('v1')
    draft.commit()
    expect(state.writes).toEqual(['v1'])

    for (const text of ['v2', 'v3', 'v4', 'v5', 'v6']) {
      draft.input(text)
      draft.commit()
    }
    expect(state.writes).toEqual(['v1']) // one in flight per field
    expect(draft.phase).toBe('saving')

    state.answers.shift()?.()
    await flushMicrotasks()
    expect(state.writes).toEqual(['v1', 'v6'])
    state.answers.shift()?.()
    await flushMicrotasks()
    expect(draft.getSnapshot().text).toBe('v6')
    expect(draft.phase).toBe('clean')
  })

  it('an answer never rewrites newer text in the field', async () => {
    const { draft, state } = setup('description', null)
    state.autoAnswer = false
    draft.focus()
    draft.input('first')
    draft.commit()
    draft.input('first and more')
    state.answers.shift()?.()
    await flushMicrotasks()
    expect(draft.getSnapshot().text).toBe('first and more')
    expect(draft.phase).toBe('pending')
    await vi.advanceTimersByTimeAsync(DESCRIPTION_DEBOUNCE_MS)
    expect(state.writes).toEqual(['first', 'first and more'])
  })

  it('a description over the limit is kept and never sent, timer or blur', async () => {
    const { draft, state } = setup('description', 'old')
    const tooLong = 'x'.repeat(10_001)
    draft.focus()
    draft.input(tooLong)
    await vi.advanceTimersByTimeAsync(DESCRIPTION_MAX_WAIT_MS * 2)
    draft.blur()
    expect(state.writes).toEqual([])
    expect(draft.getSnapshot()).toMatchObject({ text: tooLong, phase: 'invalid' })
  })
})

describe('IME composition', () => {
  it('nothing is written while composing: no debounce, no max-wait, no blur', async () => {
    const { draft, state } = setup('description', null)
    draft.focus()
    draft.compositionStart('')
    draft.input('ㄓ')
    draft.input('ㄓㄨ')
    await vi.advanceTimersByTimeAsync(DESCRIPTION_MAX_WAIT_MS * 3)
    expect(state.writes).toEqual([])
    draft.commit()
    expect(state.writes).toEqual([])
    expect(draft.getSnapshot()).toMatchObject({ text: 'ㄓㄨ', composing: true })
  })

  it('compositionend restarts the wait with the confirmed text', async () => {
    const { draft, state } = setup('description', null)
    draft.focus()
    draft.compositionStart('')
    draft.input('ㄓㄨ')
    draft.compositionEnd('專')
    expect(state.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(DESCRIPTION_DEBOUNCE_MS - 1)
    expect(state.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(state.writes).toEqual(['專'])
  })

  it('leaving the field during a composition: the text the browser leaves is not saved', () => {
    const { draft, state } = setup('title', 'Plan')
    draft.focus()
    draft.compositionStart('Plan')
    draft.input('Planㄓㄨ')
    draft.blur()
    expect(state.writes).toEqual([])
    // The browser ends the composition with the pre-edit string as the text.
    draft.compositionEnd('Planㄓㄨ')
    expect(state.writes).toEqual([])
    expect(draft.getSnapshot()).toMatchObject({
      text: 'Planㄓㄨ',
      phase: 'restored',
      unconfirmed: true,
    })
    draft.commit()
    draft.blur()
    expect(state.writes).toEqual([])

    // The user decides.
    draft.saveRestored()
    expect(state.writes).toEqual(['Planㄓㄨ'])
    expect(draft.getSnapshot().unconfirmed).toBe(false)
  })

  it('a click during a composition counts the same, and typing on makes it a normal draft', () => {
    const { draft, state } = setup('description', 'old')
    draft.focus()
    draft.compositionStart('old')
    draft.input('oldㄓ')
    draft.interruptComposition()
    draft.compositionEnd('oldㄓ')
    expect(draft.getSnapshot()).toMatchObject({ phase: 'restored', unconfirmed: true })

    draft.input('old fixed')
    expect(draft.getSnapshot()).toMatchObject({ phase: 'pending', unconfirmed: false })
    draft.commit()
    expect(state.writes).toEqual(['old fixed'])
  })

  it('a composition cut short that changed nothing leaves nothing behind', () => {
    const { draft, state } = setup('title', 'Plan')
    draft.focus()
    draft.compositionStart('Plan')
    draft.input('Planㄓ')
    draft.blur()
    draft.compositionEnd('Plan')
    expect(state.writes).toEqual([])
    expect(draft.busy).toBe(false)
  })

  it('another window taking focus counts too: the browser may end the composition as it is', () => {
    const { draft, state } = setup('title', 'Plan')
    draft.focus()
    draft.compositionStart('Plan')
    draft.input('Planㄓ')
    draft.blur({ windowOnly: true })
    draft.compositionEnd('Planㄓ')
    expect(state.writes).toEqual([])
    expect(draft.getSnapshot()).toMatchObject({ phase: 'restored', unconfirmed: true })
  })

  it('the tab being hidden during a composition sends nothing, then or afterwards', async () => {
    const { draft, state } = setup('description', 'old')
    draft.focus()
    draft.compositionStart('old')
    draft.input('oldㄓ')
    expect(draft.flush()).toBe('composing')
    expect(state.writes).toEqual([])
    draft.compositionEnd('old專')
    expect(state.writes).toEqual([]) // a normal wait starts now
    await vi.advanceTimersByTimeAsync(DESCRIPTION_DEBOUNCE_MS)
    expect(state.writes).toEqual(['old專'])
  })

  it('Esc cancelling a composition leaves the earlier text, and no write', async () => {
    const { draft, state } = setup('description', 'note')
    draft.focus()
    draft.compositionStart('note')
    draft.input('noteㄇ')
    draft.input('note')
    draft.compositionEnd('note')
    await vi.advanceTimersByTimeAsync(DESCRIPTION_DEBOUNCE_MS * 2)
    expect(state.writes).toEqual([])
    expect(draft.phase).toBe('clean')
  })

  it('a composition survives an answer: the pre-edit string stays on screen', async () => {
    const { draft, state } = setup('description', null)
    state.autoAnswer = false
    draft.focus()
    draft.input('台')
    draft.commit()
    draft.compositionStart('台')
    draft.input('台ㄅ')
    state.answers.shift()?.()
    await flushMicrotasks()
    expect(draft.getSnapshot()).toMatchObject({ text: '台ㄅ', composing: true })
    expect(state.writes).toEqual(['台'])
  })

  it('pre-edit text is never persisted', () => {
    const { draft } = setup('description', 'old')
    draft.focus()
    draft.input('stable')
    draft.compositionStart('stable')
    draft.input('stableㄓㄨ')
    expect(draft.toRecord()?.value).toBe('stable')
  })

  it('the form going away mid-composition keeps the confirmed text and writes nothing', () => {
    const { draft, state } = setup('title', 'Plan')
    draft.focus()
    draft.input('Plan B')
    draft.compositionStart('Plan B')
    draft.input('Plan Bㄓ')
    expect(draft.detach()).toBe('composing')
    expect(state.writes).toEqual([])
    expect(draft.getSnapshot()).toMatchObject({ text: 'Plan B', phase: 'restored' })
  })
})

describe('failure', () => {
  it('keeps the text, and typing again withdraws the failed Retry', async () => {
    const { draft, state } = setup('title', 'Plan')
    state.autoAnswer = false
    draft.focus()
    draft.input('Plan B')
    draft.commit()
    state.answers.shift()?.(NETWORK)
    await flushMicrotasks()
    expect(state.saved).toBe('Plan') // rolled back by the store
    expect(draft.getSnapshot()).toMatchObject({
      text: 'Plan B',
      phase: 'failed',
      error: 'Network error',
    })

    draft.input('Plan C')
    expect(state.withdrawn).toBe(1)
    expect(draft.phase).toBe('pending')
  })

  it('stays after blur (the text is not lost when focus moves on)', async () => {
    const { draft, state } = setup('description', 'old')
    state.autoAnswer = false
    draft.focus()
    draft.input('new')
    draft.blur()
    state.answers.shift()?.(NETWORK)
    await flushMicrotasks()
    expect(draft.getSnapshot()).toMatchObject({ text: 'new', phase: 'failed' })
    // A failed draft does not retry by itself on a timer.
    await vi.advanceTimersByTimeAsync(DESCRIPTION_MAX_WAIT_MS * 2)
    expect(state.writes).toEqual(['new'])
  })

  it('a store Retry that stores the text clears the failure', async () => {
    const { draft, state } = setup('description', 'old')
    state.autoAnswer = false
    draft.focus()
    draft.input('new')
    draft.blur()
    state.answers.shift()?.(NETWORK)
    await flushMicrotasks()

    state.saved = 'new' // the toast's Retry went through the store
    draft.syncSaved()
    expect(draft.phase).toBe('clean')
    expect(draft.getSnapshot().text).toBeNull()
    expect(draft.busy).toBe(false)
  })

  it('retry() sends the kept text again', async () => {
    const { draft, state } = setup('description', 'old')
    state.autoAnswer = false
    draft.focus()
    draft.input('new')
    draft.blur()
    state.answers.shift()?.(NETWORK)
    await flushMicrotasks()

    draft.retry()
    expect(state.writes).toEqual(['new', 'new'])
    state.answers.shift()?.()
    await flushMicrotasks()
    expect(draft.phase).toBe('clean')
    expect(draft.getSnapshot().text).toBeNull()
  })

  it('a failure for older text does not mark newer text as failed, and withdraws its Retry', async () => {
    const { draft, state } = setup('description', 'old')
    state.autoAnswer = false
    draft.focus()
    draft.input('v1')
    draft.commit()
    draft.input('v2')
    state.answers.shift()?.(NETWORK)
    await flushMicrotasks()
    expect(state.withdrawn).toBe(1)
    expect(draft.phase).toBe('pending')
    expect(draft.getSnapshot().text).toBe('v2')
  })

  it('a failure with newer text queued sends the newer text', async () => {
    const { draft, state } = setup('description', 'old')
    state.autoAnswer = false
    draft.focus()
    draft.input('v1')
    draft.commit()
    draft.input('v2')
    draft.commit()
    state.answers.shift()?.(NETWORK)
    await flushMicrotasks()
    expect(state.writes).toEqual(['v1', 'v2'])
    expect(draft.phase).toBe('saving')
  })

  it('typing back to the stored value leaves nothing to retry', async () => {
    const { draft, state } = setup('title', 'Plan')
    state.autoAnswer = false
    draft.focus()
    draft.input('Plan B')
    draft.commit()
    state.answers.shift()?.(NETWORK)
    await flushMicrotasks()

    draft.input('Plan')
    expect(state.withdrawn).toBe(1) // the store's Retry would have put "Plan B" over this
    expect(draft.phase).toBe('clean')
    draft.blur()
    expect(state.writes).toEqual(['Plan B'])
  })

  it('a thrown write counts as a failure and keeps the text', async () => {
    const draft = new TextDraft(FIELD_RULES.description, {
      readSaved: () => 'old',
      write: () => {
        throw new Error('boom')
      },
      withdrawFailure: () => {},
      isOffline: () => false,
      now: () => Date.now(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onChange: () => {},
    })
    draft.focus()
    draft.input('new')
    draft.commit()
    await flushMicrotasks()
    expect(draft.getSnapshot()).toMatchObject({ text: 'new', phase: 'failed', error: 'boom' })
  })
})

describe('offline', () => {
  it('holds the text instead of failing, and sends it when back online', () => {
    const { draft, state } = setup('description', 'old')
    state.offline = true
    draft.focus()
    draft.input('written offline')
    expect(draft.commit()).toBe('held')
    expect(draft.phase).toBe('held')
    expect(state.writes).toEqual([])

    state.offline = false
    draft.online()
    expect(state.writes).toEqual(['written offline'])
  })

  it('a write lost to the outage goes out again when back online', async () => {
    const { draft, state } = setup('description', 'old')
    state.autoAnswer = false
    draft.focus()
    draft.input('new')
    draft.blur()
    state.answers.shift()?.(NETWORK)
    await flushMicrotasks()
    expect(draft.phase).toBe('failed')
    draft.online()
    expect(state.writes).toEqual(['new', 'new'])
  })

  it('a refused write is not sent again by itself', async () => {
    const { draft, state } = setup('description', 'old')
    state.autoAnswer = false
    draft.focus()
    draft.input('new')
    draft.blur()
    state.answers.shift()?.({ ok: false, error: { kind: 'permission', message: 'No access' } })
    await flushMicrotasks()
    draft.online()
    expect(state.writes).toEqual(['new'])
    expect(draft.phase).toBe('failed')
  })
})

describe('closing', () => {
  it('sends valid text on detach and finishes after the form is gone', async () => {
    const { draft, state } = setup('description', 'old')
    state.autoAnswer = false
    draft.focus()
    draft.input('new')
    expect(draft.detach()).toBe('sent')
    expect(draft.busy).toBe(true)
    state.answers.shift()?.()
    await flushMicrotasks()
    expect(draft.busy).toBe(false)
  })

  it('a failure after the form is gone keeps the text for later', async () => {
    const { draft, state } = setup('title', 'Plan')
    state.autoAnswer = false
    draft.focus()
    draft.input('Plan B')
    draft.detach()
    state.answers.shift()?.(NETWORK)
    await flushMicrotasks()
    expect(draft.getSnapshot()).toMatchObject({ text: 'Plan B', phase: 'failed' })
    expect(draft.busy).toBe(true)
  })

  it('an empty title on detach reverts; too-long text stays', () => {
    const empty = setup('title', 'Plan')
    empty.draft.focus()
    empty.draft.input('')
    expect(empty.draft.detach()).toBe('reverted')
    expect(empty.draft.busy).toBe(false)

    const long = setup('title', 'Plan')
    long.draft.focus()
    long.draft.input('x'.repeat(501))
    expect(long.draft.detach()).toBe('invalid')
    expect(long.draft.busy).toBe(true)
  })

  it('discard drops the text and withdraws its Retry; a queued write is cancelled', async () => {
    const { draft, state } = setup('description', 'old')
    state.autoAnswer = false
    draft.focus()
    draft.input('v1')
    draft.commit()
    draft.input('v2')
    draft.commit()
    draft.discard()
    state.answers.shift()?.()
    await flushMicrotasks()
    expect(state.writes).toEqual(['v1'])
    expect(draft.getSnapshot().text).toBeNull()
  })
})

describe('recovered text', () => {
  const record: DraftRecord = { value: 'mine', base: 'old', sent: 'old' }

  it('waits for a decision: no write on commit, blur or detach', () => {
    const { draft, state } = setup('description', 'old', record)
    expect(draft.getSnapshot()).toMatchObject({ text: 'mine', phase: 'restored' })
    expect(draft.commit()).toBe('restored')
    draft.focus()
    draft.blur()
    draft.detach()
    expect(state.writes).toEqual([])
    expect(draft.getSnapshot().text).toBe('mine')
  })

  it('saveRestored writes it; discard drops it', () => {
    const save = setup('description', 'old', record)
    save.draft.saveRestored()
    expect(save.state.writes).toEqual(['mine'])

    const drop = setup('description', 'old', record)
    drop.draft.discard()
    expect(drop.state.writes).toEqual([])
    expect(drop.draft.busy).toBe(false)
  })

  it('typing in it makes it a normal draft', async () => {
    const { draft, state } = setup('description', 'old', record)
    draft.focus()
    draft.input('mine, edited')
    expect(draft.phase).toBe('pending')
    await vi.advanceTimersByTimeAsync(DESCRIPTION_DEBOUNCE_MS)
    expect(state.writes).toEqual(['mine, edited'])
  })

  it('text that was stored after all is dropped silently (its answer was lost)', () => {
    const { draft } = setup('description', 'mine', record)
    draft.syncSaved()
    expect(draft.busy).toBe(false)
  })

  it('never shows over a newer stored value: it is a conflict until the user decides', () => {
    const { draft, state } = setup('description', 'changed on another device', record)
    draft.syncSaved()
    expect(draft.getSnapshot()).toMatchObject({ text: null, phase: 'conflict' })
    expect(draft.recoverableText).toBe('mine')

    draft.useRecovered()
    expect(draft.getSnapshot()).toMatchObject({ text: 'mine', phase: 'restored' })
    // Showing it does not save it, and later store changes don't take it away.
    draft.syncSaved()
    expect(draft.getSnapshot().phase).toBe('restored')
    expect(state.writes).toEqual([])
  })

  it('stored == the last value sent is no conflict (only that answer was lost)', () => {
    const { draft } = setup('description', 'sent before reload', {
      value: 'typed after that',
      base: 'old',
      sent: 'sent before reload',
    })
    draft.syncSaved()
    expect(draft.phase).toBe('restored')
  })
})

describe('stored value changes', () => {
  it('text saved and not touched since follows a newer stored value, and is not written back', async () => {
    const { draft, state } = setup('description', 'old')
    draft.focus()
    draft.input('mine')
    draft.commit()
    await flushMicrotasks()
    expect(draft.getSnapshot().text).toBe('mine') // still in the field, focused

    state.saved = 'from another device'
    draft.syncSaved()
    expect(draft.getSnapshot().text).toBeNull()
    draft.blur()
    expect(state.writes).toEqual(['mine'])
    expect(state.saved).toBe('from another device')
  })

  it('typing after a save counts as editing again', async () => {
    const { draft, state } = setup('description', 'old')
    draft.focus()
    draft.input('mine')
    draft.commit()
    await flushMicrotasks()
    draft.input('mine, more')
    state.saved = 'from another device'
    draft.syncSaved()
    expect(draft.getSnapshot().text).toBe('mine, more')
  })

  it('a value from elsewhere shows when there is no draft', () => {
    const { draft, state } = setup('description', 'old')
    state.saved = 'from elsewhere'
    draft.syncSaved()
    expect(draft.getSnapshot().text).toBeNull()
  })

  it('never replaces text being edited (last writer wins when it is saved)', () => {
    const { draft, state } = setup('description', 'old')
    draft.focus()
    draft.input('mine')
    state.saved = 'from elsewhere'
    draft.syncSaved()
    expect(draft.getSnapshot().text).toBe('mine')
    draft.commit()
    expect(state.writes).toEqual(['mine'])
  })
})

describe('random sequences (seeded)', () => {
  /** Small deterministic generator, so a failure can be replayed from its seed. */
  function random(seed: number) {
    let state = seed
    return (max: number) => {
      state = (state * 1664525 + 1013904223) % 4294967296
      return Math.floor((state / 4294967296) * max)
    }
  }

  it.each(Array.from({ length: 40 }, (_, index) => index + 1))(
    'seed %i: no pre-edit text is ever written, at most one write in flight, the newest text wins',
    async (seed) => {
      const next = random(seed)
      const { draft, state } = setup('description', 'start')
      state.autoAnswer = false
      const answerOldest = async (fail: boolean) => {
        const answer = state.answers.shift()
        if (!answer) return
        answer(fail ? NETWORK : undefined)
        await flushMicrotasks()
      }
      let count = 0
      let composing = false
      draft.focus()
      for (let step = 0; step < 60; step++) {
        expect(state.answers.length).toBeLessThanOrEqual(1)
        switch (next(7)) {
          case 0:
            draft.input(`text ${++count}`)
            break
          case 1:
            if (!composing) {
              draft.compositionStart(`text ${count}`)
              draft.input(`text ${count}ㄓ`)
              composing = true
            } else {
              draft.compositionEnd(`text ${++count}`)
              composing = false
            }
            break
          case 2:
            draft.commit({ revertEmpty: false })
            break
          case 3:
            await vi.advanceTimersByTimeAsync(next(3000))
            break
          case 4:
            await answerOldest(false)
            break
          case 5:
            await answerOldest(true)
            break
          case 6:
            if (draft.phase === 'failed') draft.retry()
            break
        }
      }
      if (composing) draft.compositionEnd(`text ${++count}`)
      expect(state.writes.some((value) => value?.includes('ㄓ'))).toBe(false)

      // Everything answered, the last text committed: it is what is stored.
      draft.input(`final ${seed}`)
      draft.commit({ revertEmpty: false })
      for (let round = 0; round < 5; round++) await answerOldest(false)
      await flushMicrotasks()
      expect(state.saved).toBe(`final ${seed}`)
      expect(draft.phase).toBe('clean')
    },
  )
})
