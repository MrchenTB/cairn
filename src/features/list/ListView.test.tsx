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
import { suggestPhaseColor } from '@/domain/phaseColors'
import type { Result, Task } from '@/domain/types'
import { PhaseDialogHost } from '@/features/projects/PhaseDialog'
import { usePhaseDialog } from '@/features/projects/phaseDialogStore'
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
      <PhaseDialogHost />
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
    await waitFor(() =>
      expect(rowTitles()).toEqual(['Buy stamps', 'Post the letter', 'Water plants']),
    )
    expect(tasksOf(project.id).map((task) => task.title)).toEqual([
      'Buy stamps',
      'Post the letter',
      'Water plants',
    ])

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'New task' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add task' })).toHaveFocus()
  })

  it('lets the browser skip off-screen rows (fixed 36px height, content-visibility)', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Big' }))
    must(await a.createTask({ projectId: project.id, title: 'One' }))
    renderList(project.id)
    const row = document.querySelector('[data-task-row]') as HTMLElement
    expect(row.className).toContain('h-9')
    expect(row.className).toContain('[content-visibility:auto]')
    expect(row.className).toContain('[contain-intrinsic-size:auto_36px]')
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
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Task title must be at most 500 characters.',
    )
    expect(tasksOf(project.id)).toHaveLength(1)
  })
})

describe('ListView — phases', () => {
  async function seedPhased() {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const discovery = must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
    const report = must(await a.createPhase({ projectId: project.id, name: 'Report' }))
    must(
      await a.createTask({
        projectId: project.id,
        title: 'Interview users',
        phaseId: discovery.id,
      }),
    )
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
    await user.type(
      screen.getByRole('textbox', { name: 'New task in Discovery' }),
      'Synthesis{Enter}',
    )

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

  it('colours a phase from its dot and from the menu; the dot shows the project colour until then', async () => {
    const { project } = await seedPhased()
    const phaseId = () =>
      Object.values(useWorkspaceStore.getState().data.phases).find((p) => p.name === 'Discovery')!
        .id
    const color = () => useWorkspaceStore.getState().data.phases[phaseId()].color
    const { user } = renderList(project.id)
    // Unset: the dot is the project's colour, and says so.
    await user.click(screen.getByRole('button', { name: /^Color of Discovery: Project color/ }))
    await user.click(await screen.findByRole('radio', { name: 'Teal' }))
    await waitFor(() => expect(color()).toBe('teal'))
    // The ⋯ menu has the same picker.
    await user.click(screen.getByRole('button', { name: 'Actions for phase Discovery' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Color…' }))
    const teal = await screen.findByRole('radio', { name: 'Teal' })
    expect(teal).toBeChecked()
    await user.click(screen.getByRole('radio', { name: 'Orange' }))
    await waitFor(() => expect(color()).toBe('orange'))
    await user.click(screen.getByRole('button', { name: /^Color of Discovery: Orange/ }))
    await user.click(await screen.findByRole('button', { name: 'Use project color' }))
    await waitFor(() => expect(color()).toBeNull())
    // "No phase" has no colour of its own.
    expect(screen.queryByRole('button', { name: /^Color of No phase/ })).toBeNull()
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
    must(
      await a.createTask({ projectId: project.id, title: 'Forum post', parentTaskId: parent.id }),
    )
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

  it('puts the cursor in the new subtask field after "Add subtask" is chosen from a menu', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const parent = must(await a.createTask({ projectId: project.id, title: 'Recruit' }))
    const { user } = renderList(project.id)

    // The row's ⋯ menu.
    await user.click(screen.getByRole('button', { name: 'Actions for Recruit' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Add subtask' }))
    const field = await screen.findByRole('textbox', { name: 'New subtask of Recruit' })
    await waitFor(() => expect(field).toHaveFocus())
    await user.keyboard('Email list{Enter}')
    await waitFor(() => expect(byTitle(project.id, 'Email list')?.parentTaskId).toBe(parent.id))
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: /New subtask/ })).not.toBeInTheDocument(),
    )

    // The right-click menu.
    const row = document.querySelector(`[data-task-row="${parent.id}"]`)
    if (!row) throw new Error('row not rendered')
    await user.pointer({ keys: '[MouseRight]', target: row })
    await user.click(await screen.findByRole('menuitem', { name: 'Add subtask' }))
    const again = await screen.findByRole('textbox', { name: 'New subtask of Recruit' })
    await waitFor(() => expect(again).toHaveFocus())
  })

  it('puts the cursor in the group\'s add row after "Add task" is chosen from its menu', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const discovery = must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
    must(
      await a.createTask({
        projectId: project.id,
        title: 'Interview users',
        phaseId: discovery.id,
      }),
    )
    const { user } = renderList(project.id)

    await user.click(screen.getByRole('button', { name: 'Actions for phase Discovery' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Add task' }))
    const field = await screen.findByRole('textbox', { name: 'New task in Discovery' })
    await waitFor(() => expect(field).toHaveFocus())
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
    await waitFor(() =>
      expect(useWorkspaceStore.getState().data.tasks[task.id].dueDate).toBe(tomorrow),
    )
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
    await user.click(
      screen.getByRole('button', { name: /^Milestone Kick-off, Tuesday, October 20, 2026/ }),
    )
    expect(useUIStore.getState().milestoneDialog).toEqual({
      mode: 'edit',
      milestoneId: milestone.id,
    })
  })
})

describe('ListView — "No phase"', () => {
  it('is hidden while empty; moving a task there from the menu brings it back, after the phases', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const discovery = must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
    must(
      await a.createTask({
        projectId: project.id,
        title: 'Interview users',
        phaseId: discovery.id,
      }),
    )
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
    // "No phase" is the last group of a project with phases (not the first).
    expect(rowTitles()).toEqual(['Interview users', 'Survey'])
  })

  it('stays visible, after the phases, when it only holds milestones', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const discovery = must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
    must(
      await a.createTask({
        projectId: project.id,
        title: 'Interview users',
        phaseId: discovery.id,
      }),
    )
    must(await a.createMilestone({ projectId: project.id, name: 'Kick-off', date: '2026-10-20' }))
    renderList(project.id)

    const headers = screen.getAllByRole('button', { name: /, \d+ tasks?$/ })
    expect(headers.map((header) => header.getAttribute('aria-label'))).toEqual([
      'Discovery, 1 task',
      'No phase, 0 tasks',
    ])
    expect(screen.getByRole('button', { name: 'No phase, 0 tasks' })).toHaveAttribute(
      'title',
      '0 tasks, 1 milestone',
    )
    expect(screen.getByRole('button', { name: /^Milestone Kick-off/ })).toBeInTheDocument()
  })
})

describe('ListView — columns and counts', () => {
  it('names the priority and date columns and offers a start date on a row that has none', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const task = must(await a.createTask({ projectId: project.id, title: 'Draft guide' }))
    const { user } = renderList(project.id)

    const header = document.querySelector('[data-list-scroll] > div[aria-hidden]') as HTMLElement
    expect(header).toHaveTextContent('PriorityStartDue')

    const row = document.querySelector(`[data-task-row="${task.id}"]`) as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Start date: not set' }))
    await user.click(await screen.findByRole('button', { name: /^Tomorrow/ }))
    const tomorrow = addDays(todayInTimeZone(useWorkspaceStore.getState().preferences.timezone), 1)
    await waitFor(() =>
      expect(useWorkspaceStore.getState().data.tasks[task.id].startDate).toBe(tomorrow),
    )
  })

  it('counts top-level tasks in a phase header and spells out subtasks and milestones in its tooltip', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const discovery = must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
    const parent = must(
      await a.createTask({
        projectId: project.id,
        title: 'Interview users',
        phaseId: discovery.id,
      }),
    )
    must(
      await a.createTask({
        projectId: project.id,
        title: 'Recruit',
        parentTaskId: parent.id,
        phaseId: discovery.id,
      }),
    )
    must(
      await a.createMilestone({
        projectId: project.id,
        name: 'Interviews done',
        date: '2026-10-20',
        phaseId: discovery.id,
      }),
    )
    renderList(project.id)
    const header = screen.getByRole('button', { name: 'Discovery, 1 task' })
    expect(header).toHaveAttribute('title', '1 task, 1 subtask, 1 milestone')
  })
})

describe('ListView — empty project', () => {
  it('"Add a phase first" opens the inline phase row in the list, with the cursor in it', async () => {
    const project = must(await getWorkspaceActions().createProject({ name: 'Side project' }))
    const { user } = renderList(project.id)

    await user.click(screen.getByRole('button', { name: 'Add a phase first' }))
    const input = screen.getByRole('textbox', { name: 'New phase name' })
    expect(input).toHaveFocus()
    await user.type(input, 'Research{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Research, 0 tasks' })).toBeInTheDocument(),
    )
    // Rapid entry: the cursor stays in the phase row after the list took over.
    expect(screen.getByRole('textbox', { name: 'New phase name' })).toHaveFocus()
  })

  it('invites to add the first task inline (phases optional)', async () => {
    const project = must(await getWorkspaceActions().createProject({ name: 'Side project' }))
    const { user } = renderList(project.id)

    expect(screen.getByRole('heading', { name: 'No tasks yet' })).toBeInTheDocument()
    expect(screen.getByText(/Phases are optional/)).toBeInTheDocument()
    await user.type(
      screen.getByRole('textbox', { name: 'Add your first task' }),
      'Sketch idea{Enter}',
    )

    await waitFor(() => expect(rowTitles()).toEqual(['Sketch idea']))
    // The list keeps an add row open for the next one.
    expect(screen.getByRole('textbox', { name: 'New task' })).toHaveFocus()
  })
})

describe('ListView — default phase colours', () => {
  const phasesOf = (projectId: string) =>
    Object.values(useWorkspaceStore.getState().data.phases)
      .filter((phase) => phase.projectId === projectId)
      .sort(bySortOrder)
  const colorsOf = (projectId: string) => phasesOf(projectId).map((phase) => phase.color)
  const namesOf = (projectId: string) => phasesOf(projectId).map((phase) => phase.name)

  async function seedTwoInherited() {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
    must(await a.createPhase({ projectId: project.id, name: 'Report' }))
    return project
  }

  it('gives phases added inline distinct colours, in palette order', async () => {
    // A new project is gray, which no phase colour is spent on.
    const project = must(await getWorkspaceActions().createProject({ name: 'Side project' }))
    const { user } = renderList(project.id)

    await user.click(screen.getByRole('button', { name: 'Add a phase first' }))
    for (const [index, name] of ['Research', 'Build', 'Launch'].entries()) {
      await user.type(screen.getByRole('textbox', { name: 'New phase name' }), `${name}{Enter}`)
      await waitFor(() => expect(phasesOf(project.id)).toHaveLength(index + 1))
    }
    expect(namesOf(project.id)).toEqual(['Research', 'Build', 'Launch'])
    expect(colorsOf(project.id)).toEqual(['blue', 'violet', 'pink'])
  })

  it('leaves existing phases alone, and moving phases around never recolours them', async () => {
    const project = await seedTwoInherited()
    expect(colorsOf(project.id)).toEqual([null, null])
    const { user } = renderList(project.id)

    await user.click(screen.getByRole('button', { name: 'Add phase' }))
    await user.type(screen.getByRole('textbox', { name: 'New phase name' }), 'Launch{Enter}')
    await waitFor(() => expect(phasesOf(project.id)).toHaveLength(3))
    // Both existing phases show the (gray) project colour, so the new one is blue.
    expect(namesOf(project.id)).toEqual(['Discovery', 'Report', 'Launch'])
    expect(colorsOf(project.id)).toEqual([null, null, 'blue'])

    await user.click(screen.getByRole('button', { name: 'Actions for phase Launch' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move phase up' }))
    await waitFor(() => expect(namesOf(project.id)).toEqual(['Discovery', 'Launch', 'Report']))
    await user.click(screen.getByRole('button', { name: 'Actions for phase Discovery' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move phase down' }))
    await waitFor(() => expect(namesOf(project.id)).toEqual(['Launch', 'Discovery', 'Report']))
    // Each phase kept its own colour through the moves.
    expect(colorsOf(project.id)).toEqual(['blue', null, null])
  })

  it('suggests the same colour in the dialog as the inline add does for the same state', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research', color: 'blue' }))
    must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
    must(await a.createPhase({ projectId: project.id, name: 'Report', color: 'violet' }))
    const { user } = renderList(project.id)
    const expected = suggestPhaseColor(phasesOf(project.id), 'blue')
    expect(expected).toBe('pink')

    act(() => usePhaseDialog.getState().open(project.id))
    const dialog = await screen.findByRole('dialog', { name: 'New phase' })
    expect(within(dialog).getByRole('radio', { name: 'Pink' })).toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Add phase' }))
    await user.type(screen.getByRole('textbox', { name: 'New phase name' }), 'Launch{Enter}')
    await waitFor(() => expect(phasesOf(project.id)).toHaveLength(3))
    expect(phasesOf(project.id)[2].color).toBe(expected)
  })
})

describe('ListView — keyboard navigation (↑ / ↓)', () => {
  /** Names of the navigation stops, in the order they are drawn. */
  const stopLabel = (element: Element | null) =>
    element?.getAttribute('data-list-nav') === 'task'
      ? (element.querySelector('span')?.textContent ?? null)
      : (element?.getAttribute('aria-label') ?? null)
  const stops = () =>
    Array.from(document.querySelectorAll('[data-list-nav]')).map((element) => stopLabel(element))
  const focusedLabel = () => stopLabel(document.activeElement)

  async function seedNav() {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Nav' }))
    const discovery = must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
    const report = must(await a.createPhase({ projectId: project.id, name: 'Report' }))
    must(await a.createTask({ projectId: project.id, title: 'Loose', phaseId: null }))
    const interview = must(
      await a.createTask({ projectId: project.id, title: 'Interview', phaseId: discovery.id }),
    )
    must(
      await a.createTask({
        projectId: project.id,
        title: 'Transcribe',
        parentTaskId: interview.id,
      }),
    )
    must(await a.createTask({ projectId: project.id, title: 'Write', phaseId: report.id }))
    must(
      await a.createMilestone({
        projectId: project.id,
        name: 'Kick-off',
        date: '2026-10-20',
        phaseId: discovery.id,
      }),
    )
    return { project, discovery, report, interview }
  }

  it('moves through headers, tasks and milestones in drawing order, across phases, and stops at both ends', async () => {
    const { project } = await seedNav()
    const { user } = renderList(project.id)
    // Subtasks are collapsed (Transcribe is not a stop yet); "No phase" is drawn after the phases.
    const order = [
      'Discovery, 1 task',
      'Interview',
      expect.stringMatching(/^Milestone Kick-off/),
      'Report, 1 task',
      'Write',
      'No phase, 1 task',
      'Loose',
    ]
    expect(stops()).toEqual(order)

    const first = screen.getByRole('button', { name: 'Discovery, 1 task' })
    act(() => first.focus())
    const seen: (string | null)[] = [focusedLabel()]
    for (let i = 0; i < 9; i += 1) {
      await user.keyboard('{ArrowDown}')
      seen.push(focusedLabel())
    }
    // The last stop is "Loose": ↓ keeps focus there (no wrap-around).
    expect(seen).toEqual([...order, 'Loose', 'Loose', 'Loose'])
    for (let i = 0; i < 9; i += 1) await user.keyboard('{ArrowUp}')
    expect(first).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(first).toHaveFocus()
  })

  it('walks into subtasks once they are shown, and skips them (without opening) when hidden', async () => {
    const { project } = await seedNav()
    const { user } = renderList(project.id)
    const interview = screen.getByRole('button', { name: /^Interview/ })
    act(() => interview.focus())
    await user.keyboard('{ArrowDown}')
    expect(focusedLabel()).toMatch(/^Milestone Kick-off/)
    expect(rowTitles()).not.toContain('Transcribe')

    await user.click(screen.getByRole('button', { name: 'Show subtasks of Interview' }))
    act(() => screen.getByRole('button', { name: /^Interview/ }).focus())
    await user.keyboard('{ArrowDown}')
    expect(focusedLabel()).toBe('Transcribe')
    await user.keyboard('{ArrowDown}')
    expect(focusedLabel()).toMatch(/^Milestone Kick-off/)
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(focusedLabel()).toBe('Interview')
  })

  it('skips the rows of a collapsed phase and keeps its header as a stop', async () => {
    const { project } = await seedNav()
    const { user } = renderList(project.id)
    const discovery = screen.getByRole('button', { name: 'Discovery, 1 task' })
    await user.click(discovery)
    expect(discovery).toHaveAttribute('aria-expanded', 'false')
    await user.keyboard('{ArrowDown}')
    expect(focusedLabel()).toBe('Report, 1 task')
    await user.keyboard('{ArrowUp}')
    expect(discovery).toHaveFocus()
    // Discovery is the first stop: ↑ stays.
    await user.keyboard('{ArrowUp}')
    expect(discovery).toHaveFocus()
    // Nothing was expanded on the way.
    expect(discovery).toHaveAttribute('aria-expanded', 'false')
  })

  it('does not take the arrow keys from a text field, and does not add a task row stop', async () => {
    const { project } = await seedNav()
    const { user } = renderList(project.id)
    await user.click(screen.getByRole('button', { name: 'Add task to Report' }))
    const input = await screen.findByRole('textbox', { name: 'New task in Report' })
    await waitFor(() => expect(input).toHaveFocus())
    await user.keyboard('abc{ArrowUp}{ArrowDown}{ArrowUp}')
    expect(input).toHaveFocus()
    expect(input).toHaveValue('abc')
    // The add row is not a navigation stop.
    expect(input).not.toHaveAttribute('data-list-nav')
    for (const add of screen.getAllByRole('button', { name: /^Add (task|phase)/ })) {
      expect(add).not.toHaveAttribute('data-list-nav')
    }
  })

  it('does not move on a modified arrow, and never writes data', async () => {
    const { project } = await seedNav()
    const { user } = renderList(project.id)
    const before = JSON.stringify(useWorkspaceStore.getState().data)
    const header = screen.getByRole('button', { name: 'Discovery, 1 task' })
    act(() => header.focus())
    await user.keyboard(
      '{Shift>}{ArrowDown}{/Shift}{Alt>}{ArrowDown}{/Alt}{Control>}{ArrowDown}{/Control}',
    )
    expect(header).toHaveFocus()
    for (let i = 0; i < 12; i += 1) await user.keyboard('{ArrowDown}')
    for (let i = 0; i < 12; i += 1) await user.keyboard('{ArrowUp}')
    expect(JSON.stringify(useWorkspaceStore.getState().data)).toBe(before)
  })

  it('Enter on a focused phase header collapses it, and Enter again expands it', async () => {
    const { project } = await seedNav()
    const { user } = renderList(project.id)
    const header = screen.getByRole('button', { name: 'Report, 1 task' })
    act(() => header.focus())
    await user.keyboard('{Enter}')
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(rowTitles()).not.toContain('Write')
    expect(header).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(rowTitles()).toContain('Write')
  })

  it('opens the milestone dialog with Enter on a focused milestone', async () => {
    const { project } = await seedNav()
    const { user } = renderList(project.id)
    const milestone = screen.getByRole('button', { name: /^Milestone Kick-off/ })
    act(() => milestone.focus())
    await user.keyboard('{Enter}')
    expect(useUIStore.getState().milestoneDialog).toMatchObject({ mode: 'edit' })
  })

  it('leaves the arrow keys alone during IME composition', async () => {
    const { project } = await seedNav()
    renderList(project.id)
    const header = screen.getByRole('button', { name: 'Discovery, 1 task' })
    act(() => header.focus())
    const composing = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      header.dispatchEvent(composing)
    })
    expect(composing.defaultPrevented).toBe(false)
    expect(header).toHaveFocus()
    const process = new KeyboardEvent('keydown', {
      key: 'Process',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      header.dispatchEvent(process)
    })
    expect(header).toHaveFocus()
  })

  it('puts focus on the task that took its place when the focused task is deleted', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Del' }))
    must(await a.createTask({ projectId: project.id, title: 'One' }))
    const two = must(await a.createTask({ projectId: project.id, title: 'Two' }))
    must(await a.createTask({ projectId: project.id, title: 'Three' }))
    renderList(project.id)
    act(() => screen.getByRole('button', { name: /^Two/ }).focus())
    await act(async () => {
      await a.deleteTask(two.id, { keepSubtasks: false })
    })
    await waitFor(() => expect(focusedLabel()).toBe('Three'))
  })
})
