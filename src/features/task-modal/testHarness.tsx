/**
 * Test-only helpers for the Task Modal / milestone dialog DOM tests: a workspace seeded through
 * the real store actions (local repository), and the hosts rendered inside a memory router with
 * the confirm host (as the app shell mounts them). Not imported by app code.
 */
import { act, configure } from '@testing-library/react'
import { vi } from 'vitest'
import { useUIStore, type MilestoneDialogState, type NewTaskDefaults } from '@/app/uiStore'
import { ConfirmHost } from '@/components/ui/confirm'
import { getWorkspaceActions, useWorkspaceStore } from '@/data/store'
import type { Project, Result, Task } from '@/domain/types'
import { MilestoneDialogHost } from '@/features/milestones/MilestoneDialogHost'
import { renderUI } from '@/test/render'
import { taskDrafts } from './autosave/taskDrafts'
import { TaskModalHost } from './TaskModalHost'

// findBy* / waitFor in the files using this harness: room for loaded, parallel runs (each test
// file has its own module instance, so other suites keep the default).
configure({ asyncUtilTimeout: 4000 })

export function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Fixed clock (Date only, timers stay real) and a clean local workspace + UI state. */
export function resetTestWorld(): void {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-02T12:00:00Z') })
  localStorage.clear()
  taskDrafts.resetForTests()
  sessionStorage.clear()
  window.__cairnTest?.setLatency(0)
  window.__cairnTest?.failNextWrites(0)
  useWorkspaceStore.getState().actions.reset()
  useUIStore.setState({
    newTask: null,
    milestoneDialog: null,
    projectDialog: null,
    searchOpen: false,
  })
}

async function ready(): Promise<void> {
  must(await getWorkspaceActions().load())
  useWorkspaceStore.setState((state) => ({
    preferences: { ...state.preferences, timezone: 'UTC', weekStartsOn: 1 },
  }))
}

export interface Seeded {
  project: Project
  other: Project
  discoveryId: string
  writingId: string
  /** By title. */
  tasks: Record<string, Task>
}

/**
 * Research (Manual mode): phases Discovery + Writing;
 * Collect sources (done) → Write literature review (2 subtasks) → Submit draft (starts too early);
 * Book a room (no phase). Plus an empty second project, Community event.
 */
export async function seedWorkspace(): Promise<Seeded> {
  const a = getWorkspaceActions()
  const project = must(await a.createProject({ name: 'Research', color: 'violet' }))
  const other = must(await a.createProject({ name: 'Community event', color: 'green' }))
  const discovery = must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
  const writing = must(await a.createPhase({ projectId: project.id, name: 'Writing' }))
  const tasks: Record<string, Task> = {}
  const add = async (title: string, fields: Partial<Task> = {}) => {
    tasks[title] = must(await a.createTask({ projectId: project.id, title, ...fields }))
    return tasks[title]
  }
  await add('Collect sources', {
    phaseId: discovery.id,
    status: 'done',
    startDate: '2026-11-02',
    dueDate: '2026-11-04',
  })
  const review = await add('Write literature review', {
    phaseId: writing.id,
    status: 'in_progress',
    priority: 'high',
    startDate: '2026-11-05',
    dueDate: '2026-11-12',
    description: 'Summarise the core papers.',
  })
  await add('Outline chapters', { parentTaskId: review.id, status: 'done', dueDate: '2026-11-06' })
  await add('Draft related work', { parentTaskId: review.id, dueDate: '2026-11-10' })
  await add('Submit draft', { phaseId: writing.id, startDate: '2026-11-10', dueDate: '2026-11-11' })
  await add('Book a room')
  must(await a.addDependency(tasks['Collect sources'].id, review.id))
  must(await a.addDependency(review.id, tasks['Submit draft'].id))
  await ready()
  return { project, other, discoveryId: discovery.id, writingId: writing.id, tasks }
}

/** A loaded workspace without any project. */
export async function seedEmptyWorkspace(): Promise<void> {
  await ready()
}

/** Renders the Task Modal + milestone hosts (and confirm dialogs) at `route`. */
export function renderHosts(route = '/overview') {
  return renderUI(
    <>
      <TaskModalHost />
      <MilestoneDialogHost />
      <ConfirmHost />
    </>,
    { route },
  )
}

export function openNewTask(defaults: NewTaskDefaults = {}): void {
  act(() => useUIStore.getState().openNewTask(defaults))
}

export function openMilestoneDialog(state: MilestoneDialogState): void {
  act(() => useUIStore.getState().openMilestoneDialog(state))
}

export function storeTask(id: string): Task | undefined {
  const { tasks } = useWorkspaceStore.getState().data
  return Object.hasOwn(tasks, id) ? tasks[id] : undefined
}

export function storeTasks(): Task[] {
  return Object.values(useWorkspaceStore.getState().data.tasks)
}

/** The local repository's test hooks (dev/test builds, local mode). */
export function testHooks() {
  const hooks = window.__cairnTest
  if (!hooks) throw new Error('window.__cairnTest is not installed')
  return hooks
}
