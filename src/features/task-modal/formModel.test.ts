import { describe, expect, it } from 'vitest'
import {
  buildNewTaskInput,
  characterCount,
  hasErrors,
  initialCreateValues,
  isCreateDirty,
  sanitizeTitle,
  validateTaskForm,
} from './formModel'

describe('validateTaskForm', () => {
  const valid = initialCreateValues({})

  it('requires a title (whitespace does not count)', () => {
    expect(validateTaskForm({ ...valid, title: '' }).title).toBe('Task title is required.')
    expect(validateTaskForm({ ...valid, title: '   ' }).title).toBe('Task title is required.')
    expect(validateTaskForm({ ...valid, title: 'Plan' }).title).toBeNull()
  })

  it('rejects a due date before the start date; empty dates are fine', () => {
    const range = (startDate: string | null, dueDate: string | null) =>
      validateTaskForm({ ...valid, title: 'Plan', startDate, dueDate }).dates
    expect(range('2026-11-10', '2026-11-09')).toBe("Due date can't be before the start date.")
    expect(range('2026-11-10', '2026-11-10')).toBeNull()
    expect(range(null, '2026-11-09')).toBeNull()
    expect(range('2026-11-10', null)).toBeNull()
    expect(range(null, null)).toBeNull()
  })

  it('limits the description to 10,000 characters (code points)', () => {
    const emoji = '😀'.repeat(10_000) // 20,000 UTF-16 units, 10,000 characters
    expect(validateTaskForm({ ...valid, title: 'Plan', description: emoji }).description).toBeNull()
    expect(
      validateTaskForm({ ...valid, title: 'Plan', description: `${emoji}x` }).description,
    ).toBe('Description must be at most 10,000 characters.')
    expect(characterCount(emoji)).toBe(10_000)
  })

  it('hasErrors reflects any field error', () => {
    expect(hasErrors(validateTaskForm({ ...valid, title: 'Plan' }))).toBe(false)
    expect(hasErrors(validateTaskForm(valid))).toBe(true)
  })
})

describe('titles', () => {
  it('are single-line: pasted line breaks become spaces', () => {
    expect(sanitizeTitle('Line one\nLine two\r\nthree')).toBe('Line one Line two three')
  })
})

describe('create defaults and payload', () => {
  it('starts as To Do, no priority, no dates', () => {
    expect(initialCreateValues({})).toEqual({
      title: '',
      description: '',
      status: 'todo',
      priority: 'none',
      phaseId: null,
      startDate: null,
      dueDate: null,
    })
  })

  it("takes the opener's defaults", () => {
    const defaults = {
      projectId: 'p1',
      phaseId: 'ph-other',
      status: 'in_progress' as const,
      priority: 'high' as const,
      dueDate: '2026-11-20',
    }
    expect(initialCreateValues(defaults)).toMatchObject({
      status: 'in_progress',
      priority: 'high',
      phaseId: 'ph-other',
      dueDate: '2026-11-20',
    })
  })

  it('is dirty only when something would be lost', () => {
    const initial = initialCreateValues({ status: 'done' })
    expect(isCreateDirty(initial, initial)).toBe(false)
    expect(isCreateDirty({ ...initial, title: '  ' }, initial)).toBe(false)
    expect(isCreateDirty({ ...initial, title: 'x' }, initial)).toBe(true)
    expect(isCreateDirty({ ...initial, status: 'todo' }, initial)).toBe(true)
    expect(isCreateDirty({ ...initial, dueDate: '2026-11-03' }, initial)).toBe(true)
  })

  it('builds the createTask input: trimmed title, null for an empty description', () => {
    const values = { ...initialCreateValues({}), title: '  Draft survey  ', description: ' ' }
    expect(buildNewTaskInput(values, { projectId: 'p1' })).toEqual({
      projectId: 'p1',
      title: 'Draft survey',
      description: null,
      status: 'todo',
      priority: 'none',
      startDate: null,
      dueDate: null,
      phaseId: null,
      parentTaskId: null,
    })
    expect(
      buildNewTaskInput(values, {
        projectId: 'p1',
        placement: { afterId: 't0' },
      }),
    ).toMatchObject({ parentTaskId: null, placement: { afterId: 't0' } })
  })
})
