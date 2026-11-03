import { act, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useUIStore } from '@/app/uiStore'
import { DEFAULT_PREFERENCES, EMPTY_WORKSPACE } from '@/data/defaults'
import { useWorkspaceStore } from '@/data/store'
import {
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
  makeWorkspace,
} from '@/domain/testFactories'
import type { WorkspaceData } from '@/domain/types'
import { renderUI } from '@/test/render'
import { ProjectsPage } from './ProjectsPage'

/**
 * Research: a parent with two subtasks (one done) plus two top-level tasks (one done) and a
 * milestone → leaf tasks S1 ✓, S2, T3 ✓, T4 → 2 of 4 = 50% (the parent and the milestone never
 * count). Tasks column: 3 open of 5 (any level).
 */
function workspace(): WorkspaceData {
  const research = makeProject({
    id: 'p-research',
    name: 'Research',
    description: 'User interviews for the roadmap',
    color: 'blue',
    startDate: '2026-10-20',
    dueDate: '2026-12-15',
    sortOrder: 'a0',
  })
  const empty = makeProject({ id: 'p-empty', name: 'Side project', sortOrder: 'a1' })
  const shipped = makeProject({
    id: 'p-web',
    name: 'Website refresh',
    status: 'completed',
    sortOrder: 'a2',
  })
  const archived = makeProject({
    id: 'p-old',
    name: 'Old newsletter',
    status: 'archived',
    sortOrder: 'a3',
  })
  const phase = makePhase({ id: 'ph-1', projectId: research.id, name: 'Discovery' })
  return makeWorkspace({
    projects: [archived, shipped, empty, research],
    phases: [phase],
    tasks: [
      makeTask({ id: 'parent', projectId: research.id, phaseId: phase.id, sortOrder: 'a0' }),
      makeTask({
        projectId: research.id,
        parentTaskId: 'parent',
        phaseId: phase.id,
        status: 'done',
        title: 'S1',
      }),
      makeTask({ projectId: research.id, parentTaskId: 'parent', phaseId: phase.id, title: 'S2' }),
      makeTask({ projectId: research.id, status: 'done', sortOrder: 'a1', title: 'T3' }),
      makeTask({ projectId: research.id, sortOrder: 'a2', title: 'T4' }),
      makeTask({ projectId: shipped.id, status: 'done' }),
    ],
    milestones: [makeMilestone({ projectId: research.id, date: '2026-11-20' })],
  })
}

function seed(data: WorkspaceData) {
  act(() => {
    useWorkspaceStore.setState({
      status: 'ready',
      data,
      preferences: { ...DEFAULT_PREFERENCES, timezone: 'Asia/Taipei' },
    })
  })
}

function renderPage(route = '/projects') {
  return renderUI(<ProjectsPage />, { route })
}

/** Project names in table order. */
function visibleProjects(): string[] {
  const table = screen.getByRole('table', { name: 'Projects' })
  return within(table)
    .getAllByRole('link')
    .map((link) => link.textContent ?? '')
}

function row(name: string): HTMLElement {
  return screen.getByRole('row', { name: new RegExp(`^${name}`) })
}

beforeEach(() => {
  useUIStore.setState({ projectDialog: null })
  act(() => {
    useWorkspaceStore.setState({ data: EMPTY_WORKSPACE })
  })
})

describe('ProjectsPage — status filter', () => {
  it('shows active projects by default, in manual order', () => {
    seed(workspace())
    renderPage()
    expect(visibleProjects()).toEqual(['Research', 'Side project'])
    expect(screen.getByRole('radio', { name: 'Active (2)' })).toHaveAttribute('data-state', 'on')
  })

  it('switches to Completed / Archived / All and keeps the choice in the URL', async () => {
    seed(workspace())
    const { user, router } = renderPage()

    await user.click(screen.getByRole('radio', { name: 'Completed (1)' }))
    expect(router.state.location.search).toBe('?status=completed')
    expect(visibleProjects()).toEqual(['Website refresh'])

    await user.click(screen.getByRole('radio', { name: 'Archived (1)' }))
    expect(router.state.location.search).toBe('?status=archived')
    expect(visibleProjects()).toEqual(['Old newsletter'])

    await user.click(screen.getByRole('radio', { name: 'All (4)' }))
    expect(visibleProjects()).toEqual([
      'Research',
      'Side project',
      'Website refresh',
      'Old newsletter',
    ])

    // Active is the default: it leaves the URL clean.
    await user.click(screen.getByRole('radio', { name: 'Active (2)' }))
    expect(router.state.location.search).toBe('')
  })

  it('reads the filter from the URL and falls back to Active for unknown values', () => {
    seed(workspace())
    renderPage('/projects?status=archived')
    expect(visibleProjects()).toEqual(['Old newsletter'])
  })

  it('treats an unknown ?status as Active', () => {
    seed(workspace())
    renderPage('/projects?status=bogus')
    expect(visibleProjects()).toEqual(['Research', 'Side project'])
  })

  it('says when a status has no projects', async () => {
    const data = workspace()
    delete data.projects['p-old']
    seed(data)
    renderPage('/projects?status=archived')
    expect(screen.getByRole('heading', { name: 'No archived projects' })).toBeInTheDocument()
    await screen.findByRole('button', { name: 'Show all projects' })
  })
})

describe('ProjectsPage — quick text filter', () => {
  it('narrows by name or description and offers to clear when nothing matches', async () => {
    seed(workspace())
    const { user } = renderPage('/projects?status=all')
    const filter = screen.getByRole('searchbox', { name: 'Filter projects by name or description' })

    await user.type(filter, 'interviews') // description only
    expect(visibleProjects()).toEqual(['Research'])

    await user.clear(filter)
    await user.type(filter, 'zzz')
    const heading = screen.getByRole('heading', { name: 'No projects match “zzz”' })
    const emptyState = heading.closest('[data-slot="empty-state"]') as HTMLElement
    await user.click(within(emptyState).getByRole('button', { name: 'Clear filter' }))
    expect(filter).toHaveValue('')
    expect(visibleProjects()).toHaveLength(4)
  })

  it('Esc clears the filter', async () => {
    seed(workspace())
    const { user } = renderPage()
    const filter = screen.getByRole('searchbox', { name: 'Filter projects by name or description' })
    await user.type(filter, 'side')
    expect(visibleProjects()).toEqual(['Side project'])
    await user.keyboard('{Escape}')
    expect(filter).toHaveValue('')
    expect(visibleProjects()).toEqual(['Research', 'Side project'])
  })

  it('offers manual reordering only for the unfiltered Active list', async () => {
    seed(workspace())
    const { user } = renderPage()
    expect(screen.getAllByRole('button', { name: /^Reorder / })).toHaveLength(2)

    await user.type(screen.getByRole('searchbox', { name: /Filter projects/ }), 'research')
    expect(screen.queryAllByRole('button', { name: /^Reorder / })).toHaveLength(0)

    await user.clear(screen.getByRole('searchbox', { name: /Filter projects/ }))
    await user.click(screen.getByRole('radio', { name: 'All (4)' }))
    expect(screen.queryAllByRole('button', { name: /^Reorder / })).toHaveLength(0)
  })
})

describe('ProjectsPage — progress and counts', () => {
  it('computes progress from leaf tasks only (parents and milestones never count)', () => {
    seed(workspace())
    renderPage()
    const progress = within(row('Research')).getByRole('progressbar', {
      name: 'Research progress',
    })
    expect(progress).toHaveAttribute('aria-valuenow', '50')
    expect(progress).toHaveAttribute('aria-valuetext', '50% · 2 of 4 tasks done')
    expect(within(row('Research')).getByText('50%')).toBeInTheDocument()
  })

  it('shows "No tasks" instead of a fake percentage for an empty project', () => {
    seed(workspace())
    renderPage()
    const empty = row('Side project')
    expect(within(empty).queryByRole('progressbar')).not.toBeInTheDocument()
    expect(within(empty).getAllByText('No tasks').length).toBeGreaterThan(0)
  })

  it('shows status, dates and open / total tasks', () => {
    seed(workspace())
    renderPage('/projects?status=all')
    const research = row('Research')
    expect(within(research).getByText('Active')).toBeInTheDocument()
    expect(within(research).getByText('Oct 20 – Dec 15')).toBeInTheDocument()
    expect(within(research).getByText('3 open of 5 tasks, subtasks included')).toBeInTheDocument()
    expect(within(research).getByText('User interviews for the roadmap')).toBeInTheDocument()
    expect(within(row('Website refresh')).getByText('Completed')).toBeInTheDocument()
    expect(within(row('Website refresh')).getByText('100%')).toBeInTheDocument()
  })

  it('updates when a task is completed elsewhere (same store)', () => {
    const data = workspace()
    seed(data)
    renderPage()
    const t4 = Object.values(data.tasks).find((task) => task.title === 'T4')!
    act(() => {
      useWorkspaceStore.setState({
        data: { ...data, tasks: { ...data.tasks, [t4.id]: { ...t4, status: 'done' } } },
      })
    })
    expect(
      within(row('Research')).getByRole('progressbar', { name: 'Research progress' }),
    ).toHaveAttribute('aria-valuenow', '75')
  })
})

describe('ProjectsPage — empty workspace', () => {
  it('invites to create the first project', async () => {
    seed(EMPTY_WORKSPACE)
    const { user } = renderPage()
    expect(screen.getByRole('heading', { name: 'No projects yet' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create your first project' }))
    expect(useUIStore.getState().projectDialog).toEqual({ mode: 'create' })
  })

  it('opens the create dialog from the header button', async () => {
    seed(workspace())
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'New project' }))
    expect(useUIStore.getState().projectDialog).toEqual({ mode: 'create' })
  })
})
