import { act, screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/app/uiStore'
import { recordProjectVisit, reloadViewPrefsForTests, setProjectView } from '@/app/viewPrefs'
import { getWorkspaceActions, useWorkspaceStore } from '@/data/store'
import { renderUI } from '@/test/render'
import { SearchOverlay } from './SearchOverlay'

function must<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

interface Seeded {
  system: string
  research: string
  archived: string
  survey: string
  questions: string
  interview: string
  archivedTask: string
  review: string
}

/** Two active projects and an archived one, tasks (one subtask, one CJK) and a milestone. */
async function seed(): Promise<Seeded> {
  const a = getWorkspaceActions()
  const system = must(await a.createProject({ name: 'Design System', color: 'violet' }))
  const research = must(await a.createProject({ name: 'Research', color: 'blue' }))
  const archived = must(await a.createProject({ name: 'Old Atlas', status: 'archived' }))
  const survey = must(
    await a.createTask({ projectId: research.id, title: 'Design survey', dueDate: '2040-11-05' }),
  )
  const questions = must(
    await a.createTask({
      projectId: research.id,
      title: 'Design questions',
      parentTaskId: survey.id,
    }),
  )
  const interview = must(await a.createTask({ projectId: research.id, title: '準備訪談 demo' }))
  const archivedTask = must(await a.createTask({ projectId: archived.id, title: 'Design archive' }))
  const review = must(
    await a.createMilestone({ projectId: research.id, name: 'Design review', date: '2040-11-20' }),
  )
  must(await a.load())
  return {
    system: system.id,
    research: research.id,
    archived: archived.id,
    survey: survey.id,
    questions: questions.id,
    interview: interview.id,
    archivedTask: archivedTask.id,
    review: review.id,
  }
}

function LocationProbe() {
  const { pathname, search } = useLocation()
  return <output aria-label="location">{`${pathname}${search}`}</output>
}

function renderOverlay(route = '/overview') {
  return renderUI(
    <>
      <LocationProbe />
      <button type="button" onClick={() => useUIStore.getState().setSearchOpen(true)}>
        Open search
      </button>
      <SearchOverlay />
    </>,
    { route },
  )
}

const location = () => screen.getByLabelText('location').textContent

async function openOverlay(user: ReturnType<typeof renderOverlay>['user']) {
  await user.click(screen.getByRole('button', { name: 'Open search' }))
  return screen.findByRole('dialog', { name: 'Search' })
}

const optionNames = () => screen.getAllByRole('option').map((option) => option.textContent ?? '')

beforeEach(() => {
  localStorage.clear()
  reloadViewPrefsForTests()
  window.__cairnTest?.failNextWrites(0)
  window.__cairnTest?.setLatency(0)
  useWorkspaceStore.getState().actions.reset()
  useUIStore.setState({
    searchOpen: false,
    newTask: null,
    projectDialog: null,
    milestoneDialog: null,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SearchOverlay: empty query', () => {
  it('focuses the input and offers quick actions, navigation and recent projects', async () => {
    const ids = await seed()
    recordProjectVisit(ids.archived) // archived projects are not offered as "recent"
    recordProjectVisit(ids.research)
    const { user } = renderOverlay()
    await openOverlay(user)

    expect(screen.getByRole('combobox')).toHaveFocus()
    for (const heading of ['Quick actions', 'Go to', 'Recent projects']) {
      expect(screen.getByText(heading)).toBeInTheDocument()
    }
    const names = optionNames().join(' | ')
    for (const label of [
      'New task',
      'New project',
      'Toggle theme',
      'Go to Overview',
      'Go to My Tasks',
      'Go to Projects',
      'Go to Timeline',
      'Go to Settings',
      'Research',
    ]) {
      expect(names).toContain(label)
    }
    const recent = screen.getByText('Recent projects').closest('[cmdk-group]') as HTMLElement
    expect(
      within(recent)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Research'])
  })

  it('"Go to Settings" navigates and closes the overlay', async () => {
    await seed()
    const { user } = renderOverlay()
    await openOverlay(user)
    await user.click(screen.getByRole('option', { name: /Go to Settings/ }))

    await waitFor(() => expect(location()).toBe('/settings'))
    expect(useUIStore.getState().searchOpen).toBe(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('"New task" opens the task dialog for the project being viewed', async () => {
    const ids = await seed()
    const { user } = renderOverlay(`/projects/${ids.research}/list`)
    await openOverlay(user)
    await user.click(screen.getByRole('option', { name: /New task/ }))

    expect(useUIStore.getState().newTask).toEqual({ projectId: ids.research })
    expect(useUIStore.getState().searchOpen).toBe(false)
  })

  it('"New project" opens the project dialog in create mode', async () => {
    await seed()
    const { user } = renderOverlay()
    await openOverlay(user)
    await user.click(screen.getByRole('option', { name: /New project/ }))

    expect(useUIStore.getState().projectDialog).toEqual({ mode: 'create' })
  })

  it('"Toggle theme" saves the opposite theme through updatePreferences', async () => {
    await seed()
    const update = vi.spyOn(useWorkspaceStore.getState().actions, 'updatePreferences')
    const { user } = renderOverlay()
    await openOverlay(user)
    // jsdom reports no dark-mode preference, so the resolved theme is light.
    await user.click(screen.getByRole('option', { name: /Toggle theme/ }))

    expect(update).toHaveBeenCalledWith({ theme: 'dark' })
    expect(useUIStore.getState().searchOpen).toBe(false)
  })
})

describe('SearchOverlay: results', () => {
  it('groups results as Projects / Tasks / Milestones with their context', async () => {
    await seed()
    const { user } = renderOverlay()
    await openOverlay(user)
    await user.type(screen.getByRole('combobox'), 'design')

    for (const heading of ['Projects', 'Tasks', 'Milestones']) {
      expect(await screen.findByText(heading)).toBeInTheDocument()
    }
    const project = screen.getByRole('option', { name: /Design System/ })
    expect(project).toHaveAttribute('data-kind', 'project')

    const survey = screen.getByRole('option', { name: /^Design survey/ })
    expect(survey).toHaveTextContent('Research') // project context
    expect(survey).toHaveTextContent('Nov 5, 2040') // due date (far future: independent of today's date)
    expect(survey).toHaveTextContent('To Do') // status, readable without the icon

    const subtask = screen.getByRole('option', { name: /^Design questions/ })
    expect(subtask).toHaveTextContent('in Design survey') // parent context

    const archived = screen.getByRole('option', { name: /^Design archive/ })
    expect(archived).toHaveTextContent('Old Atlas')
    expect(within(archived).getByText('Archived')).toBeInTheDocument()

    const milestone = screen.getByRole('option', { name: /^Design review/ })
    expect(milestone).toHaveAttribute('data-kind', 'milestone')
    expect(milestone).toHaveTextContent('Nov 20, 2040')

    // Archived items rank last: the archived task is the final task row.
    const taskNames = optionNames().filter((name) => name.startsWith('Design '))
    expect(taskNames.indexOf(archived.textContent ?? '')).toBeGreaterThan(
      taskNames.indexOf(survey.textContent ?? ''),
    )
  })

  it('emphasises the matched part of a title, including CJK text', async () => {
    await seed()
    const { user } = renderOverlay()
    await openOverlay(user)

    await user.type(screen.getByRole('combobox'), 'surv')
    const survey = await screen.findByRole('option', { name: /^Design survey/ })
    expect(Array.from(survey.querySelectorAll('[data-match]')).map((n) => n.textContent)).toEqual([
      'surv',
    ])

    await user.clear(screen.getByRole('combobox'))
    await user.type(screen.getByRole('combobox'), '訪談')
    const interview = await screen.findByRole('option', { name: /準備訪談/ })
    expect(
      Array.from(interview.querySelectorAll('[data-match]')).map((n) => n.textContent),
    ).toEqual(['訪談'])
  })

  it('moves the selection with the arrow keys', async () => {
    await seed()
    const { user } = renderOverlay()
    await openOverlay(user)
    await user.type(screen.getByRole('combobox'), 'design')
    await screen.findByText('Milestones')

    const options = () => screen.getAllByRole('option')
    const selectedIndex = () =>
      options().findIndex((o) => o.getAttribute('aria-selected') === 'true')
    expect(selectedIndex()).toBe(0)
    await user.keyboard('{ArrowDown}')
    expect(selectedIndex()).toBe(1)
    await user.keyboard('{ArrowDown}{ArrowUp}')
    expect(selectedIndex()).toBe(1)
    await user.keyboard('{ArrowUp}{ArrowUp}') // loops from the first to the last row
    expect(selectedIndex()).toBe(options().length - 1)
  })

  it('shows the query and a hint when nothing matches', async () => {
    await seed()
    const { user } = renderOverlay()
    await openOverlay(user)
    await user.type(screen.getByRole('combobox'), 'zzqx')

    const list = screen.getByRole('listbox')
    expect(await within(list).findByText('No results for "zzqx"')).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('No results for "zzqx"') // announced too
  })
})

describe('SearchOverlay: why a result matched', () => {
  it('quotes the description under a result whose title does not show the match', async () => {
    const { research } = await seed()
    const a = getWorkspaceActions()
    must(
      await a.createTask({
        projectId: research,
        title: 'Prototype flow',
        description: 'A clickable prototype for the interview sessions.',
      }),
    )
    must(await a.load())
    const { user } = renderOverlay()
    await openOverlay(user)
    await user.type(screen.getByRole('combobox'), 'interview')

    const row = await screen.findByRole('option', { name: /^Prototype flow/ })
    const snippet = row.querySelector('[data-snippet]')
    expect(snippet).toHaveTextContent('…prototype for the interview sessions.')
    expect(
      Array.from(snippet?.querySelectorAll('[data-match]') ?? []).map((n) => n.textContent),
    ).toEqual(['interview'])
    // A title that shows the match needs no excerpt.
    await user.clear(screen.getByRole('combobox'))
    await user.type(screen.getByRole('combobox'), 'prototype')
    const titled = await screen.findByRole('option', { name: /^Prototype flow/ })
    expect(titled.querySelector('[data-snippet]')).toBeNull()
  })

  it('does the same for a project found through its description', async () => {
    const a = getWorkspaceActions()
    must(await a.createProject({ name: 'Roadmap 規劃', description: '市場調查與使用者訪談計畫' }))
    must(await a.load())
    const { user } = renderOverlay()
    await openOverlay(user)
    await user.type(screen.getByRole('combobox'), '訪談')

    const row = await screen.findByRole('option', { name: /Roadmap/ })
    expect(row.querySelector('[data-snippet]')).toHaveTextContent('市場調查與使用者訪談計畫')
  })
})

describe('SearchOverlay: many results', () => {
  it('says when the list was cut instead of silently dropping matches', async () => {
    await seed()
    const { research } = await seed()
    const template = Object.values(useWorkspaceStore.getState().data.tasks)[0]
    const bulk = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => {
        const id = `bulk-${String(index).padStart(2, '0')}`
        return [
          id,
          { ...template, id, projectId: research, parentTaskId: null, title: `Bulk task ${index}` },
        ]
      }),
    )
    useWorkspaceStore.setState((state) => ({
      data: { ...state.data, tasks: { ...state.data.tasks, ...bulk } },
    }))
    const { user } = renderOverlay()
    await openOverlay(user)

    await user.type(screen.getByRole('combobox'), 'bulk')
    expect(await screen.findByText(/Showing the first 50 matches/)).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(50)
    expect(screen.getByRole('status')).toHaveTextContent('Showing the first 50 results')

    // A narrower query fits: no notice.
    await user.type(screen.getByRole('combobox'), ' task 5')
    await waitFor(() => expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument())
  })
})

describe('SearchOverlay: opening a result', () => {
  it('Enter on a project opens it in its remembered view', async () => {
    const ids = await seed()
    setProjectView(ids.research, 'board')
    const { user } = renderOverlay()
    await openOverlay(user)
    await user.type(screen.getByRole('combobox'), 'research')
    await screen.findByRole('option', { name: /Research/ })
    await user.keyboard('{Enter}')

    await waitFor(() => expect(location()).toBe(`/projects/${ids.research}/board`))
    expect(useUIStore.getState().searchOpen).toBe(false)
  })

  it('clicking a task opens it over its project (?task=)', async () => {
    const ids = await seed()
    const { user } = renderOverlay()
    await openOverlay(user)
    await user.type(screen.getByRole('combobox'), 'survey')
    await user.click(await screen.findByRole('option', { name: /^Design survey/ }))

    await waitFor(() =>
      expect(location()).toBe(`/projects/${ids.research}/list?task=${ids.survey}`),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a task of an archived project opens in that project too', async () => {
    const ids = await seed()
    setProjectView(ids.archived, 'gantt')
    const { user } = renderOverlay()
    await openOverlay(user)
    await user.type(screen.getByRole('combobox'), 'design archive')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(location()).toBe(`/projects/${ids.archived}/gantt?task=${ids.archivedTask}`),
    )
  })

  it('a milestone opens the project Gantt and the milestone dialog', async () => {
    const ids = await seed()
    const { user } = renderOverlay()
    await openOverlay(user)
    await user.type(screen.getByRole('combobox'), 'design review')
    await user.click(await screen.findByRole('option', { name: /^Design review/ }))

    await waitFor(() => expect(location()).toBe(`/projects/${ids.research}/gantt`))
    expect(useUIStore.getState().milestoneDialog).toEqual({
      mode: 'edit',
      milestoneId: ids.review,
    })
    expect(useUIStore.getState().searchOpen).toBe(false)
  })
})

describe('SearchOverlay: closing', () => {
  it('Esc closes it, forgets the query and gives focus back to the opener', async () => {
    await seed()
    const { user } = renderOverlay()
    const opener = screen.getByRole('button', { name: 'Open search' })
    await openOverlay(user)
    await user.type(screen.getByRole('combobox'), 'design')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(useUIStore.getState().searchOpen).toBe(false)
    await waitFor(() => expect(opener).toHaveFocus())

    await openOverlay(user)
    expect(screen.getByRole('combobox')).toHaveValue('')
  })

  it('opens from the store flag (the shortcut path) and closes on outside interaction state', async () => {
    await seed()
    renderOverlay()
    act(() => useUIStore.getState().setSearchOpen(true))
    expect(await screen.findByRole('dialog', { name: 'Search' })).toBeInTheDocument()
    act(() => useUIStore.getState().setSearchOpen(false))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
