/**
 * Gantt view on real store data (local repository in jsdom): the row model on screen, the visual
 * per span kind with its accessible name, conflict marking, keyboard nudges, pointer drags, a drawn
 * dependency, the conflicts chip with "Resolve all…", the Auto preview and the empty states.
 */
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { reloadGanttPrefsForTests } from './ganttPrefs'
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
  reloadGanttPrefsForTests()
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
  it('lists the outline in place: undated tasks stay in their phase, no Unscheduled group', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    const rows = Array.from(chart().querySelectorAll('[data-row-key]')).map((row) =>
      row.getAttribute('data-row-key'),
    )
    expect(rows).toEqual([
      `group:${s.design.id}`,
      `task:${s.wire.id}`,
      `task:${s.visual.id}`,
      `task:${s.review.id}`,
      `task:${s.build.id}`,
      `task:${s.parent.id}`,
      `task:${s.child.id}`,
      `milestone:${s.milestone.id}`,
      'group:none', // "No phase" comes after the phases
      `task:${s.brief.id}`,
      `task:${s.idea.id}`,
    ])
    // Parent (no dates of its own) stays under Design; so does "Idea" under No phase.
    expect(screen.queryByRole('button', { name: /^Unscheduled, / })).not.toBeInTheDocument()
    // Group counts are every task of the group (subtasks included), dated or not.
    expect(
      within(screen.getByRole('button', { name: 'Design, 6 tasks' })).getByTitle(
        '6 tasks, subtasks included',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'No phase, 2 tasks' })).toBeInTheDocument()
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
    // The explanation is also in the hover tooltip (not a native title, which would double it).
    expect(visual).not.toHaveAttribute('title')
    await userEvent.setup().hover(visual)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Should start after “Wireframes”')
    expect(barOf(s.wire.id).getAttribute('aria-label')).not.toContain('conflict')
    const viewBar = screen.getByTestId('view-bar')
    expect(within(viewBar).getByRole('button', { name: '1 conflict' })).toBeInTheDocument()
    expect(chart().querySelectorAll('[data-conflict="true"]')).toHaveLength(1)
  })

  describe('phase colour', () => {
    const rowOf = (key: string) => chart().querySelector<HTMLElement>(`[data-row-key="${key}"]`)

    it('rows take their phase colour, else the project colour; subtasks follow their parent', async () => {
      const s = await seed()
      const a = getWorkspaceActions()
      must(await a.updateProject(s.project.id, { color: 'violet' }))
      must(await a.updatePhase(s.design.id, { color: 'teal' }))
      renderGantt(s.project.id)
      // Phase tasks (and the subtask, which inherits its parent's phase) and the header: teal.
      for (const key of [`group:${s.design.id}`, `task:${s.wire.id}`, `task:${s.child.id}`]) {
        expect(rowOf(key)).toHaveAttribute('data-hue', 'teal')
        expect(rowOf(key)).toHaveClass('gantt-tint')
      }
      // No phase → the project colour.
      for (const key of ['group:none', `task:${s.brief.id}`, `task:${s.idea.id}`]) {
        expect(rowOf(key)).toHaveAttribute('data-hue', 'violet')
      }
    })

    it('a task moved to another phase takes that phase’s colour; no phase falls back to the project', async () => {
      const s = await seed()
      const a = getWorkspaceActions()
      must(await a.updateProject(s.project.id, { color: 'blue' }))
      const build = must(
        await a.createPhase({ projectId: s.project.id, name: 'Build', color: 'orange' }),
      )
      must(await a.updatePhase(s.design.id, { color: 'pink' }))
      renderGantt(s.project.id)
      expect(rowOf(`task:${s.wire.id}`)).toHaveAttribute('data-hue', 'pink')
      await act(async () => {
        must(await a.updateTask(s.wire.id, { phaseId: build.id }))
      })
      expect(rowOf(`task:${s.wire.id}`)).toHaveAttribute('data-hue', 'orange')
      await act(async () => {
        must(await a.updateTask(s.wire.id, { phaseId: null }))
      })
      expect(rowOf(`task:${s.wire.id}`)).toHaveAttribute('data-hue', 'blue')
    })

    it('the dot on a phase header opens the palette; a pick saves, "Use project color" clears', async () => {
      const s = await seed()
      const { user } = renderGantt(s.project.id)
      await user.click(screen.getByRole('button', { name: /^Color of Design: Project color/ }))
      // Red is reserved for conflicts and overdue: not offered.
      expect(screen.queryByRole('radio', { name: 'Red' })).toBeNull()
      expect(
        within(screen.getByRole('radiogroup', { name: 'Color of Design' })).getAllByRole('radio'),
      ).toHaveLength(8)
      await user.click(screen.getByRole('radio', { name: 'Green' }))
      await waitFor(() =>
        expect(useWorkspaceStore.getState().data.phases[s.design.id].color).toBe('green'),
      )
      await waitFor(() => expect(rowOf(`task:${s.wire.id}`)).toHaveAttribute('data-hue', 'green'))
      await user.click(screen.getByRole('button', { name: /^Color of Design: Green/ }))
      expect(screen.getByRole('radio', { name: 'Green' })).toBeChecked()
      await user.click(screen.getByRole('button', { name: 'Use project color' }))
      await waitFor(() =>
        expect(useWorkspaceStore.getState().data.phases[s.design.id].color).toBeNull(),
      )
    })

    it('the No phase and Unscheduled headers have no colour dot', async () => {
      const s = await seed()
      renderGantt(s.project.id)
      expect(screen.queryByRole('button', { name: /^Color of No phase/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Color of Unscheduled/ })).toBeNull()
    })
  })

  it('hovering a bar shows its name, dates and length in a tooltip', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    const user = userEvent.setup()
    await user.hover(barOf(s.wire.id))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Wireframes')
    expect(tip).toHaveTextContent(/ – .+ · 4 days/)
    await user.unhover(barOf(s.wire.id))
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
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
    expect(
      screen.getByRole('button', { name: 'Show only unscheduled tasks, 1' }),
    ).toBeInTheDocument()
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

describe('GanttView: Unscheduled filter', () => {
  const toggle = (count: number) =>
    screen.getByRole('button', { name: `Show only unscheduled tasks, ${count}` })
  const rowKeys = () =>
    Array.from(chart().querySelectorAll('[data-row-key]')).map((row) =>
      row.getAttribute('data-row-key'),
    )

  it('is a toggle named with the count; filtering lists only tasks without dates', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    // Parent and Idea have neither date (Review / Build have one, Child has both).
    expect(toggle(2)).toHaveAttribute('aria-pressed', 'false')
    expect(toggle(2)).toHaveTextContent('Unscheduled 2')
    await user.click(toggle(2))
    expect(toggle(2)).toHaveAttribute('aria-pressed', 'true')
    expect(rowKeys()).toEqual([
      `group:${s.design.id}`,
      `task:${s.parent.id}`,
      'group:none',
      `task:${s.idea.id}`,
    ])
    // Headers count the matches only and say so.
    expect(
      within(screen.getByRole('button', { name: 'Design, 1 task' })).getByTitle(
        '1 task without dates, subtasks included',
      ),
    ).toBeInTheDocument()
    // The Parent's bracket (its dated Child) is still drawn: the chevron is gone, the span is real.
    expect(
      chart().querySelector(`[data-row-key="task:${s.parent.id}"] [title^="Parent (subtasks)"]`),
    ).not.toBeNull()
    await user.click(toggle(2))
    expect(toggle(2)).toHaveAttribute('aria-pressed', 'false')
    expect(rowKeys()).toHaveLength(11)
  })

  it('a scheduled parent stays as a dimmed context row for its unscheduled subtasks', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Ctx' }))
    const parent = must(
      await a.createTask({
        projectId: project.id,
        title: 'Epic',
        startDate: at(1),
        dueDate: at(4),
      }),
    )
    const sub = must(
      await a.createTask({ projectId: project.id, parentTaskId: parent.id, title: 'Loose end' }),
    )
    must(
      await a.createTask({
        projectId: project.id,
        parentTaskId: parent.id,
        title: 'Planned',
        dueDate: at(3),
      }),
    )
    const { user } = renderGantt(project.id)
    // Only the subtask counts: the parent is shown for it, not as a match.
    await user.click(toggle(1))
    expect(rowKeys()).toEqual([`task:${parent.id}`, `task:${sub.id}`])
    const context = within(
      chart().querySelector(`[data-row-key="task:${parent.id}"]`) as HTMLElement,
    ).getByRole('button', { name: /^Epic, has dates/ })
    expect(context).toHaveAccessibleName('Epic, has dates, shown for its subtasks')
    expect(context).toHaveAttribute('title', 'Epic (has dates, shown for its subtasks)')
    expect(context).toHaveClass('text-fg-tertiary')
    // Still fully interactive: the title opens the task, the bar can be reached.
    expect(barOf(parent.id)).toBeInTheDocument()
  })

  it('opening a task works in filter mode', async () => {
    const s = await seed()
    const { user, router } = renderGantt(s.project.id)
    await user.click(toggle(2))
    await user.click(
      within(chart().querySelector(`[data-row-key="task:${s.idea.id}"]`) as HTMLElement).getByRole(
        'button',
        { name: 'Idea' },
      ),
    )
    expect(router.state.location.search).toBe(`?task=${s.idea.id}`)
  })

  it('scheduling a task while filtering removes it; the toggle stays at 0 and turns the filter off', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    await user.click(toggle(2))
    await act(async () => {
      must(await getWorkspaceActions().updateTask(s.idea.id, { dueDate: at(2) }))
    })
    await waitFor(() => expect(toggle(1)).toBeInTheDocument())
    expect(rowKeys()).toEqual([`group:${s.design.id}`, `task:${s.parent.id}`])
    await act(async () => {
      must(await getWorkspaceActions().updateTask(s.parent.id, { dueDate: at(2) }))
    })
    // Nothing left: the toggle is still there (pressed, 0) and the empty state offers a way out.
    await waitFor(() => expect(toggle(0)).toHaveAttribute('aria-pressed', 'true'))
    expect(rowKeys()).toEqual([])
    expect(screen.getByText('No tasks without dates')).toBeInTheDocument()
    expect(screen.queryByText(/Drag across a row to schedule it/)).not.toBeInTheDocument()
    await user.click(toggle(0))
    expect(rowKeys()).toContain(`task:${s.idea.id}`)
    // Not pressed and no tasks without dates: the toggle hides again.
    expect(
      screen.queryByRole('button', { name: /^Show only unscheduled tasks/ }),
    ).not.toBeInTheDocument()
  })

  it('the empty state button shows all tasks again', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'One' }))
    const only = must(await a.createTask({ projectId: project.id, title: 'Only' }))
    const { user } = renderGantt(project.id)
    await user.click(toggle(1))
    await act(async () => {
      must(await getWorkspaceActions().updateTask(only.id, { dueDate: at(1) }))
    })
    await user.click(await screen.findByRole('button', { name: 'Show all tasks' }))
    expect(rowKeys()).toEqual([`task:${only.id}`])
    expect(screen.queryByText('No tasks without dates')).not.toBeInTheDocument()
  })

  it('focus on a row that leaves the filtered list moves to the toggle', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    await user.click(toggle(2))
    const idea = within(
      chart().querySelector(`[data-row-key="task:${s.idea.id}"]`) as HTMLElement,
    ).getByRole('button', { name: 'Idea' })
    act(() => idea.focus())
    expect(idea).toHaveFocus()
    await act(async () => {
      must(await getWorkspaceActions().updateTask(s.idea.id, { dueDate: at(2) }))
    })
    await waitFor(() => expect(toggle(1)).toHaveFocus())
  })

  it('goes to the top when filtering and restores the vertical scroll position afterwards', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    chart().scrollTop = 96
    chart().scrollLeft = 40
    await user.click(toggle(2))
    expect(chart().scrollTop).toBe(0)
    expect(chart().scrollLeft).toBe(40)
    await user.click(toggle(2))
    expect(chart().scrollTop).toBe(96)
  })

  it('does not touch the saved collapse prefs: filter rows start expanded and toggle separately', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    // Collapse Design in the normal view (persisted).
    await user.click(screen.getByRole('button', { name: 'Design, 6 tasks' }))
    const saved = localStorage.getItem('cairn:gantt-collapsed')
    expect(JSON.parse(saved ?? '{}')).toEqual({ [s.project.id]: [`group:${s.design.id}`] })
    expect(rowKeys()).not.toContain(`task:${s.wire.id}`)

    await user.click(toggle(2))
    // Filter mode ignores the saved collapse: the Design match is visible.
    expect(rowKeys()).toContain(`task:${s.parent.id}`)
    // Collapsing in filter mode only affects the temporary set.
    await user.click(screen.getByRole('button', { name: 'Design, 1 task' }))
    expect(rowKeys()).not.toContain(`task:${s.parent.id}`)
    expect(localStorage.getItem('cairn:gantt-collapsed')).toBe(saved)

    // Back to the normal view: the saved state (Design collapsed) is exactly as it was.
    await user.click(toggle(2))
    expect(rowKeys()).not.toContain(`task:${s.wire.id}`)
    expect(rowKeys()).toContain(`group:${s.design.id}`)
    expect(localStorage.getItem('cairn:gantt-collapsed')).toBe(saved)
    // Filtering again starts from an empty temporary set (Design's match is visible again).
    await user.click(toggle(2))
    expect(rowKeys()).toContain(`task:${s.parent.id}`)
  })
})

describe('outline pane toggle', () => {
  const hideButton = () => screen.getByRole('button', { name: 'Hide task list' })
  const showButton = () => screen.getByRole('button', { name: 'Show task list' })
  const splitter = () => screen.queryByRole('separator', { name: 'Resize task list' })
  const outlineButton = (name: string | RegExp) => within(chart()).queryByRole('button', { name })
  const rowKeys = () =>
    Array.from(chart().querySelectorAll('[data-row-key]')).map((row) =>
      row.getAttribute('data-row-key'),
    )
  const PANE_KEY = 'cairn:gantt-pane-width'
  const OUTLINE_KEY = 'cairn:gantt-outline-collapsed'
  /** prefers-reduced-motion on (the pane switches at once) or off (it animates over 200ms). */
  const reducedMotion = (reduce: boolean) =>
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: reduce && query.includes('prefers-reduced-motion'),
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    )
  beforeEach(() => {
    // The animation has its own tests below; the rest check the settled states.
    reducedMotion(true)
  })
  const outlineState = () => chart().getAttribute('data-outline')
  const paneWidthNow = () => Number(chart().getAttribute('data-pane-width'))
  /** The sticky outline cell of a row (the lane's sibling) and the row's own width. */
  const cellOf = (key: string) => {
    const row = chart().querySelector<HTMLElement>(`[data-row-key="${key}"]`) as HTMLElement
    return {
      row,
      cell: row.querySelector<HTMLElement>(':scope > div:not([data-handle="lane"])'),
      lane: row.querySelector<HTMLElement>(':scope > [data-handle="lane"]') as HTMLElement,
    }
  }

  it('is shown by default, with the splitter and a "Hide task list" button', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    expect(hideButton()).toBeInTheDocument()
    expect(splitter()).toBeInTheDocument()
    expect(outlineButton('Wireframes')).toBeInTheDocument()
    expect(localStorage.getItem(OUTLINE_KEY)).toBeNull()
    expect(outlineState()).toBe('shown')
    expect(paneWidthNow()).toBe(300)
  })

  it('puts the buttons in the Gantt header, never in the toolbar', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    // Shown: in the pane header, on the upper tier above "Task" / "Due".
    expect(chart()).toContainElement(hideButton())
    expect(hideButton().parentElement?.className).toContain('h-6')
    expect(hideButton().closest('[data-row-key]')).toBeNull()
    expect(screen.getAllByRole('button', { name: /task list$/ })).toHaveLength(1)
    await user.click(hideButton())
    // Hidden: in the top-left corner of the timeline header, outside its aria-hidden cells.
    expect(chart()).toContainElement(showButton())
    expect(showButton().closest('[aria-hidden="true"]')).toBeNull()
    expect(screen.getAllByRole('button', { name: /task list$/ })).toHaveLength(1)
  })

  it('names the button and its tooltip after what a press does', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    await user.hover(hideButton())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Hide task list')
    await user.click(hideButton())
    await user.unhover(showButton())
    await user.hover(showButton())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Show task list')
    expect(screen.queryByRole('button', { name: 'Hide task list' })).not.toBeInTheDocument()
  })

  it('hiding removes the outline cells, the header corner and the splitter; bars stay', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    expect(screen.getByText('Due')).toBeInTheDocument()
    await user.click(hideButton())
    expect(showButton()).toBeInTheDocument()
    expect(splitter()).not.toBeInTheDocument()
    expect(screen.queryByText('Due')).not.toBeInTheDocument()
    // No focusable button of the outline is left: neither task names, phase headers nor chevrons.
    expect(outlineButton('Wireframes')).not.toBeInTheDocument()
    expect(outlineButton(/^Design, /)).not.toBeInTheDocument()
    expect(outlineButton(/subtask of Parent/)).not.toBeInTheDocument()
    expect(cellOf(`task:${s.wire.id}`).cell).toBeNull()
    expect(cellOf(`group:${s.design.id}`).cell).toBeNull()
    expect(cellOf(`milestone:${s.milestone.id}`).cell).toBeNull()
    // The bars, the row width and the milestone are all still there, from the left edge.
    expect(barOf(s.wire.id)).toBeInTheDocument()
    const { row, lane } = cellOf(`task:${s.wire.id}`)
    expect(row.style.width).toBe(lane.style.width)
    expect(localStorage.getItem(OUTLINE_KEY)).toBe('true')
  })

  it('showing again restores the stored width, which hiding never touched', async () => {
    localStorage.setItem(PANE_KEY, '340')
    reloadGanttPrefsForTests()
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    expect(splitter()).toHaveAttribute('aria-valuenow', '340')
    await user.click(hideButton())
    expect(localStorage.getItem(PANE_KEY)).toBe('340')
    await user.click(showButton())
    expect(splitter()).toHaveAttribute('aria-valuenow', '340')
    expect(cellOf(`task:${s.wire.id}`).cell?.style.width).toBe('340px')
    expect(localStorage.getItem(PANE_KEY)).toBe('340')
    expect(localStorage.getItem(OUTLINE_KEY)).toBe('false')
  })

  it('stays hidden after a reload', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    await user.click(hideButton())
    cleanup()
    reloadGanttPrefsForTests()
    renderGantt(s.project.id)
    expect(showButton()).toBeInTheDocument()
    expect(splitter()).not.toBeInTheDocument()
    expect(outlineButton('Wireframes')).not.toBeInTheDocument()
  })

  it.each(['"yes"', '1', '{}', 'nonsense'])('shows the pane for a stored %s', async (raw) => {
    localStorage.setItem(OUTLINE_KEY, raw)
    reloadGanttPrefsForTests()
    const s = await seed()
    renderGantt(s.project.id)
    expect(hideButton()).toBeInTheDocument()
    expect(splitter()).toBeInTheDocument()
  })

  it('keeps the scroll position of the days: hiding and showing returns to the same offset', async () => {
    localStorage.setItem(PANE_KEY, '340')
    reloadGanttPrefsForTests()
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    const before = chart().scrollLeft
    expect(before).toBeGreaterThan(340)
    await user.click(hideButton())
    expect(chart().scrollLeft).toBe(before - 340)
    await user.click(showButton())
    expect(chart().scrollLeft).toBe(before)
  })

  it('the filter and the phase collapse keep working; the toggle never changes the collapsed prefs', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    await user.click(screen.getByRole('button', { name: 'Design, 6 tasks' }))
    const saved = localStorage.getItem('cairn:gantt-collapsed')
    expect(saved).not.toBeNull()
    await user.click(hideButton())
    // Still collapsed while hidden, and hiding did not write the prefs.
    expect(rowKeys()).not.toContain(`task:${s.wire.id}`)
    expect(localStorage.getItem('cairn:gantt-collapsed')).toBe(saved)
    // The Unscheduled filter works in the toolbar.
    await user.click(screen.getByRole('button', { name: /^Show only unscheduled tasks, / }))
    expect(rowKeys()).toContain(`task:${s.idea.id}`)
    expect(rowKeys()).not.toContain(`task:${s.brief.id}`)
    await user.click(screen.getByRole('button', { name: /^Show only unscheduled tasks, / }))
    await user.click(showButton())
    expect(localStorage.getItem('cairn:gantt-collapsed')).toBe(saved)
    expect(rowKeys()).not.toContain(`task:${s.wire.id}`)
    expect(outlineButton('Design, 6 tasks')).toBeInTheDocument()
  })

  it('a bar still opens the Task Modal while the pane is hidden', async () => {
    const s = await seed()
    const { router, user } = renderGantt(s.project.id)
    await user.click(hideButton())
    const scroller = chart()
    fireEvent.pointerDown(barOf(s.wire.id), { button: 0, pointerId: 1, clientX: 500, clientY: 100 })
    fireEvent.pointerMove(scroller, { pointerId: 1, clientX: 501, clientY: 101 })
    fireEvent.pointerUp(scroller, { pointerId: 1, clientX: 501, clientY: 101 })
    expect(router.state.location.search).toBe(`?task=${s.wire.id}`)
  })

  it('dragging a bar while hidden samples days from the left edge of the chart', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    await user.click(hideButton())
    const scroller = chart()
    const bar = barOf(s.wire.id)
    // Week scale = 16px per day; +3 days = 48px. No pane offset enters the maths.
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 500, clientY: 100 })
    fireEvent.pointerMove(scroller, { pointerId: 1, clientX: 530, clientY: 100 })
    fireEvent.pointerMove(scroller, { pointerId: 1, clientX: 548, clientY: 100 })
    fireEvent.pointerUp(scroller, { pointerId: 1, clientX: 548, clientY: 100 })
    await waitFor(() =>
      expect(storeTask(s.wire.id)).toMatchObject({ startDate: at(5), dueDate: at(8) }),
    )
  })

  it('cancels a drag in progress when the pane is toggled: no date changes', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    const scroller = chart()
    const before = { ...storeTask(s.wire.id) }
    fireEvent.pointerDown(barOf(s.wire.id), { button: 0, pointerId: 1, clientX: 500, clientY: 100 })
    fireEvent.pointerMove(scroller, { pointerId: 1, clientX: 530, clientY: 100 })
    fireEvent.pointerMove(scroller, { pointerId: 1, clientX: 548, clientY: 100 })
    fireEvent.click(hideButton())
    fireEvent.pointerUp(scroller, { pointerId: 1, clientX: 548, clientY: 100 })
    await act(async () => {})
    expect(showButton()).toBeInTheDocument()
    expect(storeTask(s.wire.id)).toMatchObject({
      startDate: before.startDate,
      dueDate: before.dueDate,
    })
  })

  it('moves focus from the outline to the button when the outline goes away', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    const name = outlineButton('Wireframes') as HTMLElement
    act(() => name.focus())
    expect(name).toHaveFocus()
    fireEvent.click(hideButton())
    expect(showButton()).toHaveFocus()
  })

  it('moves focus to the other button on every toggle, by click or by Enter', async () => {
    const s = await seed()
    const { user } = renderGantt(s.project.id)
    await user.click(hideButton())
    expect(showButton()).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(hideButton()).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(showButton()).toHaveFocus()
  })

  it('with reduced motion switches at once: no hiding / showing state', async () => {
    const s = await seed()
    renderGantt(s.project.id)
    fireEvent.click(hideButton())
    expect(outlineState()).toBe('hidden')
    expect(paneWidthNow()).toBe(0)
    fireEvent.click(showButton())
    expect(outlineState()).toBe('shown')
    expect(paneWidthNow()).toBe(300)
    expect(s.project.id).toBeTruthy()
  })

  describe('animated', () => {
    beforeEach(() => {
      reducedMotion(false)
      localStorage.setItem(PANE_KEY, '340')
      reloadGanttPrefsForTests()
    })

    it('slides the pane through widths between 0 and the stored width and lands exactly', async () => {
      const s = await seed()
      renderGantt(s.project.id)
      const before = chart().scrollLeft
      expect(paneWidthNow()).toBe(340)
      fireEvent.click(hideButton())
      expect(outlineState()).toBe('hiding')
      // Under way: strictly between the two ends, the pane's own cell as wide as the attribute,
      // the splitter gone, the cells out of the Tab order.
      await waitFor(() => {
        const width = paneWidthNow()
        expect(width).toBeGreaterThan(0)
        expect(width).toBeLessThan(340)
        expect(outlineState()).toBe('hiding')
      })
      const cell = cellOf(`task:${s.wire.id}`).cell
      expect(cell).not.toBeNull()
      expect(cell?.hasAttribute('inert')).toBe(true)
      expect(splitter()).not.toBeInTheDocument()
      await waitFor(() => expect(outlineState()).toBe('hidden'), { timeout: 3000 })
      expect(paneWidthNow()).toBe(0)
      expect(chart().scrollLeft).toBe(before - 340)
      expect(cellOf(`task:${s.wire.id}`).cell).toBeNull()
      expect(localStorage.getItem(PANE_KEY)).toBe('340')

      fireEvent.click(showButton())
      expect(outlineState()).toBe('showing')
      await waitFor(() => expect(outlineState()).toBe('shown'), { timeout: 3000 })
      expect(paneWidthNow()).toBe(340)
      expect(chart().scrollLeft).toBe(before)
      expect(splitter()).toHaveAttribute('aria-valuenow', '340')
      expect(cellOf(`task:${s.wire.id}`).cell?.hasAttribute('inert')).toBe(false)
      expect(cellOf(`task:${s.wire.id}`).cell?.style.width).toBe('340px')
    })

    it('keeps the content at its full width and slides it by what the pane lacks', async () => {
      const s = await seed()
      renderGantt(s.project.id)
      fireEvent.click(hideButton())
      await waitFor(() => {
        const width = paneWidthNow()
        expect(width).toBeGreaterThan(0)
        expect(width).toBeLessThan(340)
      })
      const { cell } = cellOf(`task:${s.wire.id}`)
      const inner = cell?.firstElementChild as HTMLElement
      expect(inner.style.width).toBe('340px')
      expect(cell?.style.width).toBe(`${chart().getAttribute('data-pane-width')}px`)
      expect(inner.style.transform).toMatch(/^translateX\(-/)
      await waitFor(() => expect(outlineState()).toBe('hidden'), { timeout: 3000 })
    })

    it('rapid toggling ends exactly at the target with the right scroll position', async () => {
      const s = await seed()
      renderGantt(s.project.id)
      const before = chart().scrollLeft
      for (let i = 0; i < 5; i++) {
        fireEvent.click(i % 2 === 0 ? hideButton() : showButton())
      }
      await waitFor(() => expect(outlineState()).toBe('hidden'), { timeout: 3000 })
      expect(paneWidthNow()).toBe(0)
      expect(chart().scrollLeft).toBe(before - 340)
      for (let i = 0; i < 5; i++) {
        fireEvent.click(i % 2 === 0 ? showButton() : hideButton())
      }
      await waitFor(() => expect(outlineState()).toBe('shown'), { timeout: 3000 })
      expect(paneWidthNow()).toBe(340)
      expect(chart().scrollLeft).toBe(before)
      expect(localStorage.getItem(PANE_KEY)).toBe('340')
      expect(localStorage.getItem(OUTLINE_KEY)).toBe('false')
      expect(storeTask(s.wire.id)).toMatchObject({ startDate: at(2), dueDate: at(5) })
    })

    it('ignores a press on a bar and a nudge while the pane moves, and accepts them after', async () => {
      const s = await seed()
      const { router } = renderGantt(s.project.id)
      const scroller = chart()
      const before = { ...storeTask(s.wire.id) }
      fireEvent.click(hideButton())
      expect(outlineState()).toBe('hiding')
      fireEvent.pointerDown(barOf(s.wire.id), {
        button: 0,
        pointerId: 1,
        clientX: 500,
        clientY: 100,
      })
      fireEvent.pointerMove(scroller, { pointerId: 1, clientX: 530, clientY: 100 })
      fireEvent.pointerMove(scroller, { pointerId: 1, clientX: 548, clientY: 100 })
      fireEvent.pointerUp(scroller, { pointerId: 1, clientX: 548, clientY: 100 })
      fireEvent.keyDown(barOf(s.wire.id), { key: 'ArrowRight', altKey: true })
      await act(async () => {})
      await waitFor(() => expect(outlineState()).toBe('hidden'), { timeout: 3000 })
      expect(storeTask(s.wire.id)).toMatchObject({
        startDate: before.startDate,
        dueDate: before.dueDate,
      })
      expect(router.state.location.search).toBe('')
      // Settled: the same drag now moves the task by +3 days (Week scale, 16px a day).
      fireEvent.pointerDown(barOf(s.wire.id), {
        button: 0,
        pointerId: 2,
        clientX: 500,
        clientY: 100,
      })
      fireEvent.pointerMove(scroller, { pointerId: 2, clientX: 530, clientY: 100 })
      fireEvent.pointerMove(scroller, { pointerId: 2, clientX: 548, clientY: 100 })
      fireEvent.pointerUp(scroller, { pointerId: 2, clientX: 548, clientY: 100 })
      await waitFor(() =>
        expect(storeTask(s.wire.id)).toMatchObject({ startDate: at(5), dueDate: at(8) }),
      )
    })
  })
})
