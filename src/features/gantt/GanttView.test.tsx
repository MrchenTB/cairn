/**
 * Gantt view on real store data (local repository in jsdom): the row model on screen, the visual
 * per span kind with its accessible name, conflict marking, keyboard nudges, pointer drags, a drawn
 * dependency, the conflicts chip with "Resolve all…", the Auto preview and the empty states.
 */
import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/app/uiStore'
import { reloadViewPrefsForTests } from '@/app/viewPrefs'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getWorkspaceActions, useWorkspaceStore } from '@/data/store'
import { addDays, todayInTimeZone } from '@/domain/dates'
import type { ScheduleMode, Task } from '@/domain/types'
import { ViewBarSlotProvider } from '@/features/projects/viewBar'
import { notify } from '@/lib/notify'
import { GanttView } from './GanttView'
import { RescheduleDialogHost } from './RescheduleDialog'

function Harness() {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  return (
    <TooltipProvider delayDuration={0}>
      <div ref={setSlot} data-testid="view-bar" />
      <ViewBarSlotProvider slot={slot}>
        <GanttView />
      </ViewBarSlotProvider>
      <RescheduleDialogHost />
    </TooltipProvider>
  )
}

function renderGantt(projectId: string) {
  const router = createMemoryRouter(
    [{ path: '/projects/:projectId/gantt', element: <Harness /> }],
    {
      initialEntries: [`/projects/${projectId}/gantt`],
    },
  )
  const user = userEvent.setup()
  render(<RouterProvider router={router} />)
  return { router, user }
}

function must<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

const today = () => todayInTimeZone(useWorkspaceStore.getState().preferences.timezone)
const at = (days: number) => addDays(today(), days)
const storeTask = (id: string): Task => useWorkspaceStore.getState().data.tasks[id]

/** A phased project with every span kind, a parent with subtasks, milestones and a conflict. */
async function seed(mode: ScheduleMode = 'manual') {
  const a = getWorkspaceActions()
  const project = must(await a.createProject({ name: 'Launch' }))
  if (mode === 'auto') must(await a.updateProject(project.id, { scheduleMode: 'auto' }))
  const design = must(await a.createPhase({ projectId: project.id, name: 'Design' }))
  const t = async (title: string, extra: Partial<Task> = {}) =>
    must(await a.createTask({ projectId: project.id, title, ...extra }))
  const brief = await t('Brief', { startDate: at(-2), dueDate: at(1), status: 'done' })
  const wire = await t('Wireframes', { phaseId: design.id, startDate: at(2), dueDate: at(5) })
  const visual = await t('Visual', { phaseId: design.id, startDate: at(4), dueDate: at(8) })
  const review = await t('Review', { phaseId: design.id, dueDate: at(9) })
  const build = await t('Build', { phaseId: design.id, startDate: at(10) })
  const parent = await t('Parent', { phaseId: design.id })
  const child = await t('Child', { parentTaskId: parent.id, startDate: at(3), dueDate: at(4) })
  const idea = await t('Idea')
  const milestone = must(
    await a.createMilestone({
      projectId: project.id,
      name: 'Sign-off',
      date: at(9),
      phaseId: design.id,
    }),
  )
  const conflict = must(await a.addDependency(wire.id, visual.id)) // Visual starts before Wireframes ends
  must(await a.load())
  return {
    project,
    design,
    brief,
    wire,
    visual,
    review,
    build,
    parent,
    child,
    idea,
    milestone,
    conflict,
  }
}

const chart = () => screen.getByRole('region', { name: 'Gantt chart' })
const barOf = (taskId: string) =>
  chart().querySelector<HTMLElement>(`[data-task-id="${taskId}"][data-link-target]`) as HTMLElement

beforeEach(() => {
  localStorage.clear()
  reloadViewPrefsForTests()
  useWorkspaceStore.getState().actions.reset()
  useUIStore.setState({ newTask: null })
  // jsdom has no layout: give the scroll container a desktop-sized viewport.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GanttView', () => {
  it('lists the outline: phase header, tasks with subtasks, milestone, Unscheduled (n)', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    const rows = Array.from(chart().querySelectorAll('[data-row-key]')).map((row) =>
      row.getAttribute('data-row-key'),
    )
    expect(rows).toEqual([
      'group:none',
      `task:${s.brief.id}`,
      `group:${s.design.id}`,
      `task:${s.wire.id}`,
      `task:${s.visual.id}`,
      `task:${s.review.id}`,
      `task:${s.build.id}`,
      `task:${s.parent.id}`,
      `task:${s.child.id}`,
      `milestone:${s.milestone.id}`,
      'unscheduled',
      `task:${s.idea.id}`,
    ])
    expect(screen.getByRole('button', { name: 'Unscheduled, 1 task' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    // Each outline row: status glyph, title (opens the modal), due text.
    const wireRow = chart().querySelector(`[data-row-key="task:${s.wire.id}"]`) as HTMLElement
    expect(within(wireRow).getByRole('img', { name: 'Status: To Do' })).toBeInTheDocument()
    expect(within(wireRow).getByRole('button', { name: 'Wireframes' })).toBeInTheDocument()
  })

  it('draws every span kind with a descriptive accessible name', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    expect(barOf(s.wire.id)).toHaveAttribute('data-handle', 'move')
    expect(barOf(s.wire.id).getAttribute('aria-label')).toMatch(
      /^Wireframes, .+ – .+, 4 days, To Do$/,
    )
    expect(barOf(s.brief.id).getAttribute('aria-label')).toMatch(/, Done$/)
    expect(barOf(s.review.id)).toHaveAttribute('data-handle', 'point')
    expect(barOf(s.review.id).getAttribute('aria-label')).toMatch(
      /^Review, Due .+, no start date, To Do$/,
    )
    expect(barOf(s.build.id).getAttribute('aria-label')).toMatch(
      /^Build, Starts .+, no due date, To Do$/,
    )
    const diamond = chart().querySelector(`[data-milestone-id="${s.milestone.id}"]`) as HTMLElement
    expect(diamond.getAttribute('aria-label')).toMatch(/^Milestone Sign-off, /)
    // A parent without own dates shows the read-only bracket over its subtasks; no bar of its own.
    expect(barOf(s.parent.id)).toBeNull()
    expect(chart().querySelector('[title^="Parent (subtasks): "]')).not.toBeNull()
    // The undated task has an empty, drawable lane.
    expect(barOf(s.idea.id)).toBeNull()
  })

  it('marks the conflicting successor (name + tooltip) and counts conflicts in the view bar', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    const visual = barOf(s.visual.id)
    expect(visual.getAttribute('aria-label')).toContain(
      'dependency conflict: Should start after “Wireframes” ends',
    )
    expect(visual).toHaveAttribute('title', expect.stringContaining('Should start after'))
    expect(barOf(s.wire.id).getAttribute('aria-label')).not.toContain('conflict')
    const viewBar = screen.getByTestId('view-bar')
    expect(within(viewBar).getByRole('button', { name: '1 conflict' })).toBeInTheDocument()
    expect(chart().querySelectorAll('[data-conflict="true"]')).toHaveLength(1)
  })

  it('keyboard: Alt+→ moves a bar one day, Alt+Shift+← shortens it, Enter opens the task', async () => {
    const s = await seed()
    const { router } = renderGantt(s.project.id)
    const bar = barOf(s.child.id)
    bar.focus()
    fireEvent.keyDown(bar, { key: 'ArrowRight', altKey: true })
    await waitFor(() =>
      expect(storeTask(s.child.id)).toMatchObject({ startDate: at(4), dueDate: at(5) }),
    )
    fireEvent.keyDown(barOf(s.child.id), { key: 'ArrowLeft', altKey: true, shiftKey: true })
    await waitFor(() =>
      expect(storeTask(s.child.id)).toMatchObject({ startDate: at(4), dueDate: at(4) }),
    )
    // A one-day task cannot end before it starts: nothing is written.
    fireEvent.keyDown(barOf(s.child.id), { key: 'ArrowLeft', altKey: true, shiftKey: true })
    expect(storeTask(s.child.id)).toMatchObject({ startDate: at(4), dueDate: at(4) })
    fireEvent.keyDown(barOf(s.child.id), { key: 'Enter' })
    expect(router.state.location.search).toBe(`?task=${s.child.id}`)
  })

  it('pointer: dragging the body moves both dates, a click without movement opens the modal', async () => {
    const s = await seed()
    const { router } = renderGantt(s.project.id)
    const scroller = chart()
    const bar = barOf(s.wire.id)
    // Default Week scale = 16px per day; +3 days = 48px.
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 500, clientY: 100 })
    fireEvent.pointerMove(scroller, { pointerId: 1, clientX: 530, clientY: 100 })
    fireEvent.pointerMove(scroller, { pointerId: 1, clientX: 548, clientY: 100 })
    fireEvent.pointerUp(scroller, { pointerId: 1, clientX: 548, clientY: 100 })
    await waitFor(() =>
      expect(storeTask(s.wire.id)).toMatchObject({ startDate: at(5), dueDate: at(8) }),
    )
    expect(router.state.location.search).toBe('')

    fireEvent.pointerDown(barOf(s.wire.id), { button: 0, pointerId: 2, clientX: 500, clientY: 100 })
    fireEvent.pointerMove(scroller, { pointerId: 2, clientX: 501, clientY: 101 })
    fireEvent.pointerUp(scroller, { pointerId: 2, clientX: 501, clientY: 101 })
    expect(router.state.location.search).toBe(`?task=${s.wire.id}`)
  })

  it('pointer: Esc cancels a drag and the resize handle keeps at least one day', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    const scroller = chart()
    fireEvent.pointerDown(barOf(s.visual.id), {
      button: 0,
      pointerId: 3,
      clientX: 500,
      clientY: 100,
    })
    fireEvent.pointerMove(scroller, { pointerId: 3, clientX: 580, clientY: 100 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerUp(scroller, { pointerId: 3, clientX: 580, clientY: 100 })
    expect(storeTask(s.visual.id)).toMatchObject({ startDate: at(4), dueDate: at(8) })

    const end = barOf(s.visual.id).querySelector('[data-handle="resize-end"]') as HTMLElement
    fireEvent.pointerDown(end, { button: 0, pointerId: 4, clientX: 600, clientY: 100 })
    fireEvent.pointerMove(scroller, { pointerId: 4, clientX: 300, clientY: 100 })
    fireEvent.pointerUp(scroller, { pointerId: 4, clientX: 300, clientY: 100 })
    await waitFor(() =>
      expect(storeTask(s.visual.id)).toMatchObject({ startDate: at(4), dueDate: at(4) }),
    )
  })

  it('drawing from the out dot to another bar adds the dependency; a cycle is refused', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    const scroller = chart()
    const target = barOf(s.build.id)
    const elementFromPoint = vi.fn(() => target as Element)
    Object.defineProperty(document, 'elementFromPoint', {
      value: elementFromPoint,
      configurable: true,
    })
    const out = barOf(s.visual.id).querySelector('[data-handle="link-out"]') as HTMLElement
    fireEvent.pointerDown(out, { button: 0, pointerId: 5, clientX: 600, clientY: 120 })
    fireEvent.pointerMove(scroller, { pointerId: 5, clientX: 700, clientY: 180 })
    fireEvent.pointerUp(scroller, { pointerId: 5, clientX: 700, clientY: 180 })
    await waitFor(() =>
      expect(
        Object.values(useWorkspaceStore.getState().data.dependencies).some(
          (d) => d.predecessorId === s.visual.id && d.successorId === s.build.id,
        ),
      ).toBe(true),
    )
    // Build → Wireframes would close Wireframes → Visual → Build.
    elementFromPoint.mockReturnValue(barOf(s.wire.id))
    const buildOut = barOf(s.build.id).querySelector('[data-handle="link-out"]') as HTMLElement
    const before = Object.keys(useWorkspaceStore.getState().data.dependencies).length
    fireEvent.pointerDown(buildOut, { button: 0, pointerId: 6, clientX: 700, clientY: 180 })
    fireEvent.pointerMove(scroller, { pointerId: 6, clientX: 400, clientY: 110 })
    fireEvent.pointerUp(scroller, { pointerId: 6, clientX: 400, clientY: 110 })
    expect(Object.keys(useWorkspaceStore.getState().data.dependencies)).toHaveLength(before)
    Reflect.deleteProperty(document, 'elementFromPoint')
  })

  it('dropping a link on its own bar adds nothing and says a task cannot depend on itself', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    const scroller = chart()
    const own = barOf(s.visual.id)
    // The pointer is over the bar's body (not over its dots) when it is released.
    Object.defineProperty(document, 'elementFromPoint', {
      value: vi.fn(() => own as Element),
      configurable: true,
    })
    const warning = vi.spyOn(notify, 'warning')
    const before = Object.keys(useWorkspaceStore.getState().data.dependencies).length
    const out = own.querySelector('[data-handle="link-out"]') as HTMLElement
    fireEvent.pointerDown(out, { button: 0, pointerId: 7, clientX: 600, clientY: 120 })
    fireEvent.pointerMove(scroller, { pointerId: 7, clientX: 560, clientY: 120 })
    fireEvent.pointerUp(scroller, { pointerId: 7, clientX: 560, clientY: 120 })
    await waitFor(() =>
      expect(warning).toHaveBeenCalledWith("Can't add this dependency", {
        description: "A task can't depend on itself.",
      }),
    )
    expect(Object.keys(useWorkspaceStore.getState().data.dependencies)).toHaveLength(before)
    Reflect.deleteProperty(document, 'elementFromPoint')
  })

  it("releasing a link on the source's own dot (a click) says nothing", async () => {
    const s = await seed()
    renderGantt(s.project.id)
    const scroller = chart()
    const own = barOf(s.visual.id)
    const out = own.querySelector('[data-handle="link-out"]') as HTMLElement
    Object.defineProperty(document, 'elementFromPoint', {
      value: vi.fn(() => out as Element),
      configurable: true,
    })
    const warning = vi.spyOn(notify, 'warning')
    fireEvent.pointerDown(out, { button: 0, pointerId: 8, clientX: 600, clientY: 120 })
    fireEvent.pointerUp(scroller, { pointerId: 8, clientX: 600, clientY: 120 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(warning).not.toHaveBeenCalled()
    Reflect.deleteProperty(document, 'elementFromPoint')
  })

  it('"Resolve all…" previews the shifts and applies them in one write', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    await user.click(
      within(screen.getByTestId('view-bar')).getByRole('button', { name: '1 conflict' }),
    )
    const list = await screen.findByRole('list', { name: 'Conflicts' })
    expect(list).toHaveTextContent('Wireframes')
    expect(list).toHaveTextContent('Visual')
    await user.click(screen.getByRole('button', { name: 'Resolve all…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Resolve dependency conflicts' })
    expect(dialog).toHaveTextContent('Visual')
    expect(dialog).toHaveTextContent('+2d')
    const apply = vi.spyOn(getWorkspaceActions(), 'applySchedule')
    await user.click(within(dialog).getByRole('button', { name: 'Apply 1 change' }))
    await waitFor(() =>
      expect(storeTask(s.visual.id)).toMatchObject({ startDate: at(6), dueDate: at(10) }),
    )
    expect(apply).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(
        within(screen.getByTestId('view-bar')).queryByRole('button', { name: /conflict/ }),
      ).toBeNull(),
    )
  })

  it('Auto mode: a drag that pushes a successor opens the preview; Cancel writes nothing', async () => {
    const s = await seed('auto')
    must(await getWorkspaceActions().removeDependency(s.conflict.id))
    must(await getWorkspaceActions().addDependency(s.brief.id, s.wire.id))
    const { user } = renderGantt(s.project.id)
    const before = { brief: storeTask(s.brief.id), wire: storeTask(s.wire.id) }
    // Brief +2 days (32px on Week) now ends after Wireframes starts.
    fireEvent.pointerDown(barOf(s.brief.id), { button: 0, pointerId: 7, clientX: 400, clientY: 60 })
    fireEvent.pointerMove(chart(), { pointerId: 7, clientX: 432, clientY: 60 })
    fireEvent.pointerUp(chart(), { pointerId: 7, clientX: 432, clientY: 60 })
    const dialog = await screen.findByRole('dialog', { name: 'Move dependent tasks?' })
    expect(dialog).toHaveTextContent('Wireframes')
    expect(within(dialog).getByRole('button', { name: 'Apply 2 changes' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Only move this task' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(storeTask(s.brief.id)).toMatchObject({
      startDate: before.brief.startDate,
      dueDate: before.brief.dueDate,
    })
    expect(storeTask(s.wire.id)).toMatchObject({
      startDate: before.wire.startDate,
      dueDate: before.wire.dueDate,
    })
  })

  it('switches scale (persisted per project) and dependency mode (saved on the project)', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    const viewBar = within(screen.getByTestId('view-bar'))
    await user.click(viewBar.getByRole('radio', { name: 'Day' }))
    expect(JSON.parse(localStorage.getItem('cairn:gantt-scales') ?? '{}')).toEqual({
      [s.project.id]: 'day',
    })
    await user.click(viewBar.getByRole('button', { name: 'Dependencies: Manual' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Auto/ }))
    await waitFor(() =>
      expect(useWorkspaceStore.getState().data.projects[s.project.id].scheduleMode).toBe('auto'),
    )
  })

  it('empty project: "No tasks yet" with New task for this project', async () => {
    const project = must(await getWorkspaceActions().createProject({ name: 'Empty' }))
    const { user } = renderGantt(project.id)
    expect(screen.getByRole('heading', { name: 'No tasks yet' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New task' }))
    expect(useUIStore.getState().newTask).toEqual({ projectId: project.id })
  })

  it('only undated tasks: the chart shows the "Drag across a row" hint', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Ideas' }))
    must(await a.createTask({ projectId: project.id, title: 'Someday' }))
    renderGantt(project.id)
    expect(screen.getAllByText(/Drag across a row to schedule it/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Unscheduled, 1 task' })).toBeInTheDocument()
  })

  it('double-clicking an empty lane schedules a one-day task there', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    const lane = chart().querySelector(
      `[data-row-key="task:${s.idea.id}"] [data-handle="lane"]`,
    ) as HTMLElement
    Object.defineProperty(document, 'elementFromPoint', { value: () => lane, configurable: true })
    await act(async () => {
      fireEvent.doubleClick(chart(), { clientX: 700, clientY: 400 })
    })
    await waitFor(() => {
      const idea = storeTask(s.idea.id)
      expect(idea.startDate).not.toBeNull()
      expect(idea.startDate).toBe(idea.dueDate)
    })
    Reflect.deleteProperty(document, 'elementFromPoint')
  })
})
