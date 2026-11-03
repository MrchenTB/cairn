import { act, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES, EMPTY_WORKSPACE } from '@/data/defaults'
import { useWorkspaceStore } from '@/data/store'
import { todayInTimeZone } from '@/domain/dates'
import { makeProject, makeTask, makeWorkspace } from '@/domain/testFactories'
import type { Preferences, Project } from '@/domain/types'
import { renderUI } from '@/test/render'
import { recordProjectVisit, reloadViewPrefsForTests } from '../viewPrefs'
import { Sidebar } from './Sidebar'

const TIME_ZONE = 'Asia/Taipei'

function seed(
  projects: Project[],
  preferences: Partial<Preferences> = {},
  tasks = [] as ReturnType<typeof makeTask>[],
) {
  useWorkspaceStore.setState({
    status: 'ready',
    data: makeWorkspace({ projects, tasks }),
    preferences: { ...DEFAULT_PREFERENCES, timezone: TIME_ZONE, ...preferences },
  })
}

const projects = ['A', 'B', 'C', 'D', 'E', 'F'].map((name, index) =>
  makeProject({ id: name.toLowerCase(), name, sortOrder: `a${index}` }),
)

function recentNames(): string[] {
  const section = screen.getByRole('region', { name: 'Recent' })
  return within(section)
    .getAllByRole('link')
    .map((link) => link.textContent ?? '')
}

beforeEach(() => {
  localStorage.clear()
  reloadViewPrefsForTests()
  useWorkspaceStore.setState({ status: 'idle', data: EMPTY_WORKSPACE })
})

describe('Sidebar', () => {
  it('lists recent projects first, topped up with active ones, at most five', () => {
    seed([
      ...projects,
      makeProject({ id: 'g', name: 'Archived', status: 'archived', sortOrder: 'Z0' }),
      makeProject({ id: 'h', name: 'Done', status: 'completed', sortOrder: 'Z1' }),
    ])
    act(() => recordProjectVisit('c'))
    renderUI(<Sidebar />, { route: '/overview' })
    expect(recentNames()).toEqual(['C', 'A', 'B', 'D', 'E'])

    act(() => recordProjectVisit('h')) // a visited completed project still counts as recent
    expect(recentNames()).toEqual(['Done', 'C', 'A', 'B', 'D'])
  })

  it('marks exactly one item as the current page on a project route', async () => {
    seed(projects)
    act(() => recordProjectVisit('b'))
    const { user } = renderUI(<Sidebar />, { route: '/projects/b/list' })
    const current = screen.getAllByRole('link', { current: 'page' })
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveTextContent('B')

    // Collapsed: the recent list is hidden, so Projects carries the current state.
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    const collapsedCurrent = screen.getAllByRole('link', { current: 'page' })
    expect(collapsedCurrent).toHaveLength(1)
    expect(collapsedCurrent[0]).toHaveAccessibleName('Projects')
  })

  it('keeps keyboard focus on the toggle when the sidebar collapses and expands', async () => {
    seed(projects)
    const { user } = renderUI(<Sidebar />, { route: '/overview' })
    const aside = screen.getByRole('complementary', { name: 'Sidebar' })
    await user.tab()
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(aside).toHaveAttribute('data-collapsed', 'true')
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveFocus()
    await user.keyboard(' ')
    expect(aside).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveFocus()
  })

  it('announces the My Tasks count in both widths', async () => {
    const today = todayInTimeZone(TIME_ZONE)
    seed(projects, {}, [
      makeTask({ projectId: 'a', dueDate: '2000-01-03' }),
      makeTask({ projectId: 'a', dueDate: today }),
      makeTask({ projectId: 'a', dueDate: '2000-01-03', status: 'done' }),
    ])
    const { user } = renderUI(<Sidebar />, { route: '/overview' })
    const myTasks = screen.getByRole('link', { name: /^My Tasks/ })
    expect(myTasks).toHaveAccessibleName('My Tasks, 2 due today or overdue (1 overdue)')
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(screen.getByRole('link', { name: /^My Tasks/ })).toHaveAccessibleName(
      'My Tasks, 2 due today or overdue (1 overdue)',
    )
  })

  it('says "Local only — not synced" in local mode', () => {
    seed(projects)
    renderUI(<Sidebar />, { route: '/overview' })
    expect(
      screen.getByRole('button', { name: 'Sync status: Local only — not synced' }),
    ).toBeInTheDocument()
  })
})
