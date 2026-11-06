import { describe, expect, it } from 'vitest'
import {
  makeDependency,
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
} from '@/domain/testFactories'
import type { Preferences, TaskPatch } from '@/domain/types'
import {
  dependencyFromRow,
  dependencyToInsert,
  dependencyToRow,
  importPayloadFromBackup,
  milestoneFromRow,
  milestonePatchToRow,
  milestoneToInsert,
  milestoneToRow,
  phaseFromRow,
  phasePatchToRow,
  phaseToInsert,
  phaseToRow,
  preferencesFromRow,
  preferencesToRow,
  projectFromRow,
  projectPatchToRow,
  projectToInsert,
  projectToRow,
  snapshotFromRows,
  taskFromRow,
  taskPatchToRow,
  taskToInsert,
  taskToRow,
} from './mappers'

const SERVER_OWNED = ['user_id', 'created_at', 'updated_at']

describe('row ↔ domain round trips', () => {
  it('projects', () => {
    const project = makeProject({
      description: 'Notes',
      status: 'completed',
      color: 'teal',
      startDate: '2026-11-02',
      dueDate: '2026-11-30',
      scheduleMode: 'auto',
      sortOrder: 'a5',
    })
    const row = projectToRow(project)
    expect(row).toEqual({
      id: project.id,
      name: 'Project',
      description: 'Notes',
      status: 'completed',
      color: 'teal',
      start_date: '2026-11-02',
      due_date: '2026-11-30',
      schedule_mode: 'auto',
      sort_order: 'a5',
      created_at: project.createdAt,
      updated_at: project.updatedAt,
    })
    expect(projectFromRow(row)).toEqual(project)
    // user_id comes back from the server but never reaches the domain.
    expect(projectFromRow({ ...row, user_id: 'user-1' })).toEqual(project)
  })

  it('phases', () => {
    const phase = makePhase({ projectId: 'p1', name: 'Design', sortOrder: 'a1' })
    const row = phaseToRow(phase)
    expect(row).toMatchObject({ project_id: 'p1', name: 'Design', sort_order: 'a1' })
    expect(phaseFromRow(row)).toEqual(phase)
  })

  it('phase colours: written only when set, read as null when absent or unknown', () => {
    const plain = makePhase({ projectId: 'p1' })
    expect(phaseToInsert(plain)).not.toHaveProperty('color') // works on a database without the column
    const teal = makePhase({ projectId: 'p1', color: 'teal' })
    expect(phaseToInsert(teal)).toMatchObject({ color: 'teal' })
    expect(phaseFromRow(phaseToRow(teal))).toEqual(teal)
    // A row from a database that has not run the migration, or from a newer palette.
    const { color: _, ...withoutColor } = phaseToRow(plain)
    expect(phaseFromRow(withoutColor).color).toBeNull()
    expect(phaseFromRow({ ...phaseToRow(plain), color: 'magenta' as never }).color).toBeNull()
    expect(phaseFromRow({ ...phaseToRow(plain), color: 'red' as never }).color).toBeNull()
    // Patches: a colour, and null to go back to the project colour.
    expect(phasePatchToRow({ color: 'blue' })).toEqual({ color: 'blue' })
    expect(phasePatchToRow({ color: null })).toEqual({ color: null })
  })

  it('tasks', () => {
    const task = makeTask({
      projectId: 'p1',
      phaseId: 'ph1',
      parentTaskId: 't0',
      title: 'Write',
      description: 'Body',
      status: 'done',
      priority: 'urgent',
      startDate: '2026-11-02',
      dueDate: '2026-11-03',
      sortOrder: 'a3',
      completedAt: '2026-11-03T10:00:00.000Z',
    })
    const row = taskToRow(task)
    expect(row).toMatchObject({
      project_id: 'p1',
      phase_id: 'ph1',
      parent_task_id: 't0',
      start_date: '2026-11-02',
      due_date: '2026-11-03',
      sort_order: 'a3',
      completed_at: '2026-11-03T10:00:00.000Z',
    })
    expect(taskFromRow(row)).toEqual(task)
    // PostgREST timestamps keep their precision and offset untouched.
    const precise = { ...row, updated_at: '2026-11-02T08:30:00.123456+00:00' }
    expect(taskFromRow(precise).updatedAt).toBe('2026-11-02T08:30:00.123456+00:00')
  })

  it('milestones and dependencies', () => {
    const milestone = makeMilestone({ projectId: 'p1', phaseId: 'ph1', date: '2026-12-01' })
    expect(milestoneToRow(milestone)).toMatchObject({ phase_id: 'ph1', date: '2026-12-01' })
    expect(milestoneFromRow(milestoneToRow(milestone))).toEqual(milestone)

    const dependency = makeDependency({ projectId: 'p1', predecessorId: 'a', successorId: 'b' })
    expect(dependencyToRow(dependency)).toMatchObject({
      project_id: 'p1',
      predecessor_id: 'a',
      successor_id: 'b',
      type: 'FS',
    })
    expect(dependencyFromRow(dependencyToRow(dependency))).toEqual(dependency)
  })

  it('preferences', () => {
    const preferences: Preferences = {
      theme: 'dark',
      sidebarCollapsed: true,
      timezone: 'Asia/Taipei',
      weekStartsOn: 0,
    }
    const row = preferencesToRow(preferences)
    expect(row).toEqual({
      theme: 'dark',
      sidebar_collapsed: true,
      timezone: 'Asia/Taipei',
      week_starts_on: 0,
    })
    expect(preferencesFromRow({ ...row, user_id: 'u', created_at: 'x', updated_at: 'y' })).toEqual(
      preferences,
    )
  })
})

describe('insert payloads', () => {
  it('omit user_id, created_at and updated_at (and completed_at for tasks)', () => {
    const payloads = [
      projectToInsert(makeProject()),
      phaseToInsert(makePhase({ projectId: 'p' })),
      taskToInsert(
        makeTask({ projectId: 'p', status: 'done', completedAt: '2026-11-01T00:00:00Z' }),
      ),
      milestoneToInsert(makeMilestone({ projectId: 'p', date: '2026-11-02' })),
      dependencyToInsert(makeDependency({ projectId: 'p', predecessorId: 'a', successorId: 'b' })),
    ]
    for (const payload of payloads) {
      for (const column of SERVER_OWNED) expect(payload).not.toHaveProperty(column)
      expect(payload).toHaveProperty('id')
    }
    expect(payloads[2]).not.toHaveProperty('completed_at')
  })

  it('import payload keeps completion times and drops timestamps', () => {
    const task = makeTask({ projectId: 'p', status: 'done', completedAt: '2026-10-01T00:00:00Z' })
    const payload = importPayloadFromBackup({
      projects: [makeProject({ id: 'p' })],
      phases: [],
      tasks: [task],
      milestones: [],
      dependencies: [],
    })
    expect(payload.tasks[0]).toMatchObject({ id: task.id, completed_at: '2026-10-01T00:00:00Z' })
    expect(payload.tasks[0]).not.toHaveProperty('created_at')
    expect(payload.projects[0]).not.toHaveProperty('user_id')
  })
})

describe('patches', () => {
  it('map field by field: undefined is skipped, null is kept', () => {
    expect(
      taskPatchToRow({
        title: 'New',
        startDate: null,
        dueDate: undefined,
        phaseId: 'ph',
        parentTaskId: null,
        sortOrder: 'a1',
      }),
    ).toEqual({
      title: 'New',
      start_date: null,
      phase_id: 'ph',
      parent_task_id: null,
      sort_order: 'a1',
    })
    expect(projectPatchToRow({ scheduleMode: 'auto', dueDate: null })).toEqual({
      schedule_mode: 'auto',
      due_date: null,
    })
    expect(phasePatchToRow({ name: 'Build' })).toEqual({ name: 'Build' })
    expect(milestonePatchToRow({ date: '2026-12-24', phaseId: null })).toEqual({
      date: '2026-12-24',
      phase_id: null,
    })
    expect(projectPatchToRow({})).toEqual({})
  })

  it('never forwards fields outside the patch type (ids, project, timestamps)', () => {
    const sneaky = { title: 'x', projectId: 'other', id: 'y', completedAt: 'z' } as TaskPatch
    expect(taskPatchToRow(sneaky)).toEqual({ title: 'x' })
  })
})

describe('snapshotFromRows', () => {
  it('maps every table and a missing preferences row to null', () => {
    const project = makeProject({ id: 'p' })
    const task = makeTask({ projectId: 'p' })
    const snapshot = snapshotFromRows({
      projects: [projectToRow(project)],
      phases: [],
      tasks: [taskToRow(task)],
      milestones: [],
      dependencies: [],
      preferences: null,
    })
    expect(snapshot).toEqual({
      projects: [project],
      phases: [],
      tasks: [task],
      milestones: [],
      dependencies: [],
      preferences: null,
    })
  })
})
