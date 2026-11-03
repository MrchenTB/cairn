import { useState } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/app/uiStore'
import { ConfirmHost } from '@/components/ui/confirm'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getWorkspaceActions, useWorkspaceStore } from '@/data/store'
import { addDays, todayInTimeZone } from '@/domain/dates'
import { bySortOrder } from '@/domain/ordering'
import type { Result, Task } from '@/domain/types'
import { ViewBarSlotProvider } from '@/features/projects/viewBar'
import { resetListPrefsForTests } from './listPrefs'
import { ListView } from './ListView'

function Harness() {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  return (
    <TooltipProvider delayDuration={0}>
      <div ref={setSlot} data-testid="view-bar" />
      <ViewBarSlotProvider slot={slot}>
        <ListView />
      </ViewBarSlotProvider>
      <ConfirmHost />
    </TooltipProvider>
  )
}

function renderList(projectId: string) {
  const router = createMemoryRouter([{ path: '/projects/:projectId/list', element: <Harness /> }], {
    initialEntries: [`/projects/${projectId}/list`],
  })
  const user = userEvent.setup()
  render(<RouterProvider router={router} />)
  return { router, user }
}

function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

const tasksOf = (projectId: string): Task[] =>
  Object.values(useWorkspaceStore.getState().data.tasks)
    .filter((task) => task.projectId === projectId)
    .sort(bySortOrder)
const byTitle = (projectId: string, title: string) =>
  tasksOf(projectId).find((task) => task.title === title)
/** Titles of the rendered task rows (subtasks included), in order. */
const rowTitles = () =>
  Array.from(document.querySelectorAll('[data-task-row]')).map(
    (row) => row.querySelector('button.flex-1 > span')?.textContent,
  )

// Interaction-heavy tests; the default 5 s is tight when the machine is busy.
vi.setConfig({ testTimeout: 20_000 })

beforeEach(async () => {
  localStorage.clear()
  sessionStorage.clear()
  resetListPrefsForTests()
  useWorkspaceStore.getState().actions.reset()
  must(await getWorkspaceActions().load())
})

describe('ListView — flat project (no phases)', () => {
  it('lists tasks without group headers and adds tasks rapidly with Enter', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Errands' }))
    must(await a.createTask({ projectId: project.id, title: 'Buy stamps' }))
    const { user } = renderList(project.id)

    expect(rowTitles()).toEqual(['Buy stamps'])
    expect(screen.queryByRole('button', { name: /^No phase/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add task' }))
    const input = screen.getByRole('textbox', { name: 'New task' })
    await user.type(input, 'Post the letter{Enter}')
    await user.type(input, 'Water plants{Enter}')
    // Focus stays in the add row for rapid entry.
    expect(input).toHaveFocus()
    await waitFor(() => expect(rowTitles()).toEqual(['Buy stamps', 'Post the letter', 'Water plants']))
    expect(tasksOf(project.id).map((task) => task.title)).toEqual([
      'Buy stamps',
      'Post the letter',
      'Water plants',
    ])

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'New task' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add task' })).toHaveFocus()
  })

  it('rejects an empty or invalid title inline (nothing is created)', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Errands' }))
    must(await a.createTask({ projectId: project.id, title: 'Buy stamps' }))
    const { user } = renderList(project.id)
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    const input = screen.getByRole('textbox', { name: 'New task' })
    await user.type(input, `${'x'.repeat(501)}{Enter}`)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Task title must be at most 500 characters.')
    expect(tasksOf(project.id)).toHaveLength(1)
  })
})

describe('ListView — phases', () => {
  async function seedPhased() {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const discovery = must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
    const report = must(await a.createPhase({ projectId: project.id, name: 'Report' }))
    must(await a.createTask({ projectId: project.id, title: 'Interview users', phaseId: discovery.id }))
    must(await a.createTask({ projectId: project.id, title: 'Write report', phaseId: report.id }))
    must(await a.createTask({ projectId: project.id, title: 'Survey', phaseId: discovery.id }))
    return { project, discovery, report }
  }

  it('groups by phase, hides an empty "No phase" group and collapses groups', async () => {
    const { project } = await seedPhased()
    const { user } = renderList(project.id)

    expect(screen.queryByRole('button', { name: /^No phase/ })).not.toBeInTheDocument()
    const discoveryHeader = screen.getByRole('button', { name: 'Discovery, 2 tasks' })
    expect(discoveryHeader).toHaveAttribute('aria-expanded', 'true')
    expect(rowTitles()).toEqual(['Interview users', 'Survey', 'Write report'])

    await user.click(discoveryHeader)
    expect(discoveryHeader).toHaveAttribute('aria-expanded', 'false')
    expect(rowTitles()).toEqual(['Write report'])
  })

  it('adds a task at the end of its phase group (phase + placement)', async () => {
    const { project, discovery } = await seedPhased()
    const { user } = renderList(project.id)

    await user.click(screen.getByRole('button', { name: 'Add task to Discovery' }))
    await user.type(screen.getByRole('textbox', { name: 'New task in Discovery' }), 'Synthesis{Enter}')

    const created = await waitFor(() => {
      const task = byTitle(project.id, 'Synthesis')
      expect(task).toBeDefined()
      return task as Task
    })
    expect(created.phaseId).toBe(discovery.id)
    // Directly after the group's last task in the project's single ordering space.
    expect(tasksOf(project.id).map((task) => task.title)).toEqual([
      'Interview users',
      'Write report',
      'Survey',
      'Synthesis',
    ])
    expect(rowTitles()).toEqual(['Interview users', 'Survey', 'Synthesis', 'Write report'])
  })

  it('moves a task to another phase from its menu, by keyboard (the drag alternative)', async () => {
    const { project, report } = await seedPhased()
    const { user } = renderList(project.id)

    await user.click(screen.getByRole('button', { name: 'Actions for Survey' }))
    const submenu = await screen.findByRole('menuitem', { name: 'Move to phase' })
    act(() => submenu.focus())
    await user.keyboard('{ArrowRight}')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'No phase' })).toHaveFocus())
    // The current phase (Discovery) is disabled and skipped.
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Report' })).toHaveFocus())
    await user.keyboard('{Enter}')

    await waitFor(() => expect(byTitle(project.id, 'Survey')?.phaseId).toBe(report.id))
    expect(rowTitles()).toEqual(['Interview users', 'Write report', 'Survey'])
  })

  it('moves a task up within its group from its menu', async () => {
    const { project } = await seedPhased()
    const { user } = renderList(project.id)
    await user.click(screen.getByRole('button', { name: 'Actions for Survey' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move up' }))
    await waitFor(() => expect(rowTitles()).toEqual(['Survey', 'Interview users', 'Write report']))
  })

  it('confirms a phase delete with what becomes ungrouped', async () => {
    const { project } = await seedPhased()
    const { user } = renderList(project.id)
    await user.click(screen.getByRole('button', { name: 'Actions for phase Discovery' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete phase…' }))
    const confirmDialog = await screen.findByRole('alertdialog', {
      name: 'Delete phase “Discovery”?',
    })
    expect(confirmDialog).toHaveTextContent(
      'Its 2 tasks become ungrouped (No phase). Nothing else is deleted.',
    )
    await user.click(within(confirmDialog).getByRole('button', { name: 'Delete phase' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'No phase, 2 tasks' })).toBeInTheDocument(),
    )
    expect(byTitle(project.id, 'Survey')?.phaseId).toBeNull()
  })
})

describe('ListView — subtasks', () => {
  it('summarises, expands and adds subtasks under their parent', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const parent = must(await a.createTask({ projectId: project.id, title: 'Recruit' }))
    must(
      await a.createTask({
        projectId: project.id,
        title: 'Email list',
        parentTaskId: parent.id,
        status: 'done',
      }),
    )
    must(await a.createTask({ projectId: project.id, title: 'Forum post', parentTaskId: parent.id }))
    const { user } = renderList(project.id)

    // Collapsed by default: the parent shows "1/2".
    expect(rowTitles()).toEqual(['Recruit'])
    expect(screen.getByRole('button', { name: /^Recruit/ })).toHaveTextContent('1/2')

    await user.click(screen.getByRole('button', { name: 'Show subtasks of Recruit' }))
    expect(rowTitles()).toEqual(['Recruit', 'Email list', 'Forum post'])

    await user.click(screen.getByRole('button', { name: 'Add subtask' }))
    await user.type(
      screen.getByRole('textbox', { name: 'New subtask of Recruit' }),
      'Book rooms{Enter}',
    )
    await waitFor(() => expect(byTitle(project.id, 'Book rooms')?.parentTaskId).toBe(parent.id))
    expect(rowTitles()).toEqual(['Recruit', 'Email list', 'Forum post', 'Book rooms'])

    await user.click(screen.getByRole('button', { name: 'Hide subtasks of Recruit' }))
    expect(rowTitles()).toEqual(['Recruit'])
  })

  it('changes a status from the row (the List updates through the store)', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const task = must(await a.createTask({ projectId: project.id, title: 'Draft guide' }))
    const { user } = renderList(project.id)

    await user.click(screen.getByRole('button', { name: 'Status: To Do' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Done/ }))
    await waitFor(() =>
      expect(useWorkspaceStore.getState().data.tasks[task.id].status).toBe('done'),
    )
    expect(screen.getByRole('button', { name: /^Draft guide/ })).toHaveTextContent(', done')
  })
})

describe('ListView — editing in place', () => {
  it('sets a due date from the row through the planner and keeps other rows as they were', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const task = must(await a.createTask({ projectId: project.id, title: 'Draft guide' }))
    must(await a.createTask({ projectId: project.id, title: 'Book rooms', priority: 'high' }))
    const { user } = renderList(project.id)

    const tomorrow = addDays(todayInTimeZone(useWorkspaceStore.getState().preferences.timezone), 1)
    const row = document.querySelector(`[data-task-row="${task.id}"]`) as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Due date: not set' }))
    await user.click(await screen.findByRole('button', { name: /^Tomorrow/ }))
    await waitFor(() => expect(useWorkspaceStore.getState().data.tasks[task.id].dueDate).toBe(tomorrow))
    expect(within(row).getByRole('button', { name: /^Due date: / })).toHaveTextContent('Tomorrow')

    // The other (memoised) row still shows its own values.
    const other = rowTitles().indexOf('Book rooms')
    expect(other).toBe(1)
    expect(screen.getAllByRole('button', { name: 'Priority: High' })).toHaveLength(1)
  })

  it('changes a priority from the row', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const task = must(await a.createTask({ projectId: project.id, title: 'Draft guide' }))
    const { user } = renderList(project.id)
    await user.click(screen.getByRole('button', { name: 'Priority: No priority' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Urgent/ }))
    await waitFor(() =>
      expect(useWorkspaceStore.getState().data.tasks[task.id].priority).toBe('urgent'),
    )
    expect(screen.getByRole('button', { name: 'Priority: Urgent' })).toBeInTheDocument()
  })

  it('expands and collapses every parent from the view bar', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const p1 = must(await a.createTask({ projectId: project.id, title: 'Recruit' }))
    must(await a.createTask({ projectId: project.id, title: 'Email list', parentTaskId: p1.id }))
    const p2 = must(await a.createTask({ projectId: project.id, title: 'Report' }))
    must(await a.createTask({ projectId: project.id, title: 'Outline', parentTaskId: p2.id }))
    const { user } = renderList(project.id)

    const viewBar = screen.getByTestId('view-bar')
    await user.click(within(viewBar).getByRole('button', { name: 'Expand subtasks' }))
    expect(rowTitles()).toEqual(['Recruit', 'Email list', 'Report', 'Outline'])
    await user.click(within(viewBar).getByRole('button', { name: 'Collapse subtasks' }))
    expect(rowTitles()).toEqual(['Recruit', 'Report'])
  })

  it('lists milestones in their group and opens them for editing', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    must(await a.createTask({ projectId: project.id, title: 'Draft guide' }))
    const milestone = must(
      await a.createMilestone({ projectId: project.id, name: 'Kick-off', date: '2026-10-20' }),
    )
    const { user } = renderList(project.id)
    await user.click(screen.getByRole('button', { name: /^Milestone Kick-off, Tuesday, October 20, 2026/ }))
    expect(useUIStore.getState().milestoneDialog).toEqual({ mode: 'edit', milestoneId: milestone.id })
  })
})

describe('ListView — "No phase"', () => {
  it('is hidden while empty; moving a task there from the menu brings it back first', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const discovery = must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
    must(await a.createTask({ projectId: project.id, title: 'Interview users', phaseId: discovery.id }))
    must(await a.createTask({ projectId: project.id, title: 'Survey', phaseId: discovery.id }))
    const { user } = renderList(project.id)
    expect(screen.queryByRole('button', { name: /^No phase/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Actions for Survey' }))
    const submenu = await screen.findByRole('menuitem', { name: 'Move to phase' })
    act(() => submenu.focus())
    await user.keyboard('{ArrowRight}')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'No phase' })).toHaveFocus())
    await user.keyboard('{Enter}')

    await waitFor(() => expect(byTitle(project.id, 'Survey')?.phaseId).toBeNull())
    expect(screen.getByRole('button', { name: 'No phase, 1 task' })).toBeInTheDocument()
    expect(rowTitles()).toEqual(['Survey', 'Interview users'])
  })
})

describe('ListView — empty project', () => {
  it('invites to add the first task inline (phases optional)', async () => {
    const project = must(await getWorkspaceActions().createProject({ name: 'Side project' }))
    const { user } = renderList(project.id)

    expect(screen.getByRole('heading', { name: 'No tasks yet' })).toBeInTheDocument()
    expect(screen.getByText(/Phases are optional/)).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Add your first task' }), 'Sketch idea{Enter}')

    await waitFor(() => expect(rowTitles()).toEqual(['Sketch idea']))
    // The list keeps an add row open for the next one.
    expect(screen.getByRole('textbox', { name: 'New task' })).toHaveFocus()
  })
})
