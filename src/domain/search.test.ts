import { describe, expect, it } from 'vitest'
import { normalizeSearchText, searchWorkspace, type SearchResult } from './search'
import { makeMilestone, makeProject, makeTask, makeWorkspace } from './testFactories'
import type { Task } from './types'

const research = makeProject({ id: 'research', name: 'Research' })
const community = makeProject({
  id: 'community',
  name: 'Community Event',
  description: 'Annual meetup planning',
})
const archived = makeProject({ id: 'old', name: 'Old stuff', status: 'archived' })

const task = (title: string, overrides: Partial<Task> = {}) =>
  makeTask({ projectId: 'research', title, ...overrides })

const labels = (results: SearchResult[]) =>
  results.map((r) =>
    r.kind === 'task' ? r.task.title : r.kind === 'project' ? r.project.name : r.milestone.name,
  )

describe('normalizeSearchText', () => {
  it('applies NFKC, lowercases and collapses whitespace', () => {
    expect(normalizeSearchText('  ＡＢＣ　Report\t\n draft ')).toBe('abc report draft')
    expect(normalizeSearchText('ｶﾀｶﾅ')).toBe('カタカナ')
    expect(normalizeSearchText('①')).toBe('1')
  })
})

describe('searchWorkspace', () => {
  it('returns [] for empty or blank queries', () => {
    const data = makeWorkspace({ projects: [research], tasks: [task('Anything')] })
    expect(searchWorkspace(data, '')).toEqual([])
    expect(searchWorkspace(data, '   ')).toEqual([])
    expect(searchWorkspace(data, '　')).toEqual([])
  })

  it('ranks exact > prefix > word-prefix > substring > description-only', () => {
    const data = makeWorkspace({
      projects: [research],
      tasks: [
        task('Annual summary', { description: 'Includes the REPORT appendix' }),
        task('Misreported numbers'),
        task('Final report draft'),
        task('Reporting tools'),
        task('Report review'),
        task('Report'),
        task('Unrelated'),
      ],
    })
    const results = searchWorkspace(data, 'report')
    expect(labels(results)).toEqual([
      'Report',
      'Report review', // prefix (shorter title first)
      'Reporting tools', // prefix
      'Final report draft', // word prefix
      'Misreported numbers', // substring
      'Annual summary', // description only
    ])
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
    }
  })

  it('is case-insensitive and NFKC-normalised (full-width, half-width kana)', () => {
    const data = makeWorkspace({
      projects: [research],
      tasks: [task('ABC meeting'), task('ＡＢＣ會議'), task('ｶﾀｶﾅ notes'), task('カタカナ')],
    })
    // Both are title-prefix matches; the shorter title wins the tie.
    expect(labels(searchWorkspace(data, 'ＡＢＣ'))).toEqual(['ＡＢＣ會議', 'ABC meeting'])
    expect(labels(searchWorkspace(data, 'abc 會議'))).toEqual(['ＡＢＣ會議'])
    expect(labels(searchWorkspace(data, 'カタカナ'))).toEqual(['カタカナ', 'ｶﾀｶﾅ notes'])
    expect(labels(searchWorkspace(data, 'ｶﾀｶﾅ'))).toEqual(['カタカナ', 'ｶﾀｶﾅ notes'])
    expect(labels(searchWorkspace(data, 'MEETING'))).toEqual(['ABC meeting'])
  })

  it('matches CJK text by substring without word segmentation', () => {
    const data = makeWorkspace({
      projects: [research],
      tasks: [
        task('期末報告撰寫'),
        task('報告整理'),
        task('會議記錄', { description: '附上報告連結' }),
      ],
    })
    expect(labels(searchWorkspace(data, '報告'))).toEqual(['報告整理', '期末報告撰寫', '會議記錄'])
    expect(labels(searchWorkspace(data, '期末　報告'))).toEqual(['期末報告撰寫']) // ideographic space
    expect(labels(searchWorkspace(data, '撰寫'))).toEqual(['期末報告撰寫'])
    expect(searchWorkspace(data, '週報')).toEqual([])
  })

  it('finds word starts at script changes, never inside a CJK run or after a combining mark', () => {
    const data = makeWorkspace({
      projects: [research],
      tasks: [
        task('xdemo'),
        task('準備demo'),
        task('Q4報告'),
        task('期末報告'),
        task('𠀀報告'), // U+20000 (CJK Extension B, a surrogate pair) before 報告
        task('किताब'),
        task('नई ताब'),
      ],
    })
    // Han → Latin starts a word: '準備demo' is a word-prefix match, 'xdemo' a mid-word one.
    expect(labels(searchWorkspace(data, 'demo'))).toEqual(['準備demo', 'xdemo'])
    // Latin/digit → Han starts a word; Han → Han (in or outside the BMP) does not.
    expect(labels(searchWorkspace(data, '報告'))).toEqual(['Q4報告', '期末報告', '𠀀報告'])
    // A vowel sign (combining mark) continues its word: 'ताब' in 'किताब' is mid-word.
    expect(labels(searchWorkspace(data, 'ताब'))).toEqual(['नई ताब', 'किताब'])
  })

  it('requires every term, each in the title or the description', () => {
    const data = makeWorkspace({
      projects: [research],
      tasks: [
        task('Write report'),
        task('Report: write it up'),
        task('Write summary', { description: 'for the quarterly report' }),
        task('Write only'),
      ],
    })
    expect(labels(searchWorkspace(data, 'write report'))).toEqual([
      'Write report', // exact phrase
      'Report: write it up', // both terms at word starts
      'Write summary', // one term only in the description
    ])
    expect(searchWorkspace(data, 'write nothing')).toEqual([])
  })

  it('ranks open tasks above done ones and archived projects last', () => {
    const data = makeWorkspace({
      projects: [research, archived],
      tasks: [
        task('Budget', { status: 'done' }),
        task('Budget', { projectId: 'old' }),
        task('Budget', { projectId: 'old', status: 'done' }),
        task('Notes', { description: 'budget details' }),
        task('Budget plan', { status: 'in_progress' }),
      ],
    })
    const results = searchWorkspace(data, 'budget')
    const summary = (r: SearchResult) =>
      r.kind === 'task' ? `${r.task.title}|${r.task.status}|${r.project.id}` : r.id
    expect(results.map(summary)).toEqual([
      'Budget plan|in_progress|research',
      'Notes|todo|research',
      'Budget|done|research',
      'Budget|todo|old',
      'Budget|done|old',
    ])
  })

  it('searches projects (name and description) and milestones (name only)', () => {
    const data = makeWorkspace({
      projects: [research, community, archived],
      tasks: [task('Research notes')],
      milestones: [
        makeMilestone({ projectId: 'community', name: 'Research checkpoint', date: '2026-12-01' }),
        makeMilestone({ projectId: 'old', name: 'Research archive', date: '2026-12-01' }),
      ],
    })
    const results = searchWorkspace(data, 'research')
    expect(results.map((r) => `${r.kind}:${labels([r])[0]}`)).toEqual([
      'project:Research',
      'task:Research notes',
      'milestone:Research checkpoint',
      'milestone:Research archive', // archived project
    ])
    const milestone = results.find((r) => r.kind === 'milestone')
    expect(milestone?.kind === 'milestone' && milestone.project.id).toBe('community')
    expect(labels(searchWorkspace(data, 'meetup'))).toEqual(['Community Event'])
  })

  it('attaches the project and the parent task of subtasks', () => {
    const parent = task('Write report', { id: 'parent' })
    const child = task('Draft outline', { parentTaskId: 'parent' })
    const data = makeWorkspace({ projects: [research], tasks: [parent, child] })
    const [result] = searchWorkspace(data, 'outline')
    expect(result.kind).toBe('task')
    if (result.kind === 'task') {
      expect(result.task).toBe(child)
      expect(result.parent).toBe(parent)
      expect(result.project).toBe(research)
      expect(result.id).toBe(child.id)
    }
    const [top] = searchWorkspace(data, 'write')
    expect(top.kind === 'task' && top.parent).toBeNull()
  })

  it('skips rows whose project is missing', () => {
    const data = makeWorkspace({
      projects: [research],
      tasks: [task('Ghost task', { projectId: 'deleted' })],
      milestones: [
        makeMilestone({ projectId: 'deleted', name: 'Ghost milestone', date: '2026-11-02' }),
      ],
    })
    expect(searchWorkspace(data, 'ghost')).toEqual([])
  })

  it('applies the limit (default 50)', () => {
    const tasks = Array.from({ length: 60 }, (_, i) => task(`Item ${i}`))
    const data = makeWorkspace({ projects: [research], tasks })
    expect(searchWorkspace(data, 'item')).toHaveLength(50)
    expect(searchWorkspace(data, 'item', { limit: 5 })).toHaveLength(5)
    expect(searchWorkspace(data, 'item', { limit: 100 })).toHaveLength(60)
    expect(searchWorkspace(data, 'item', { limit: 0 })).toEqual([])
  })

  it('sees edits to the same entity object (cache safety)', () => {
    const mutable = task('Before')
    const data = makeWorkspace({ projects: [research], tasks: [mutable] })
    expect(labels(searchWorkspace(data, 'before'))).toEqual(['Before'])
    mutable.title = 'After'
    expect(searchWorkspace(data, 'before')).toEqual([])
    expect(labels(searchWorkspace(data, 'after'))).toEqual(['After'])
  })

  it('stays fast on a large workspace', () => {
    const tasks = Array.from({ length: 5_000 }, (_, i) =>
      task(`Task number ${i}`, { description: i % 2 ? '期末報告 notes' : null }),
    )
    const data = makeWorkspace({ projects: [research], tasks })
    searchWorkspace(data, 'warm up')
    const started = performance.now()
    expect(searchWorkspace(data, 'number 報告')).toHaveLength(50)
    expect(performance.now() - started).toBeLessThan(100)
  })
})
