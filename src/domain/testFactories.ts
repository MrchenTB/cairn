/**
 * Test-data factories for domain entities (used by *.test.ts; never imported by app code).
 * Every factory returns a complete, valid row; pass overrides for the fields a test cares about.
 */
import type { Dependency, Milestone, Phase, Project, Task, Timestamp, WorkspaceData } from './types'

const CREATED_AT: Timestamp = '2026-11-01T00:00:00.000Z'
let sequence = 0

/** Unique, readable id: `${prefix}-${n}`. */
export function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}-${sequence}`
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: nextId('project'),
    name: 'Project',
    description: null,
    status: 'active',
    color: 'gray',
    startDate: null,
    dueDate: null,
    scheduleMode: 'manual',
    sortOrder: 'a0',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  }
}

export function makePhase(overrides: Partial<Phase> & Pick<Phase, 'projectId'>): Phase {
  return {
    id: nextId('phase'),
    name: 'Phase',
    sortOrder: 'a0',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  }
}

export function makeTask(overrides: Partial<Task> & Pick<Task, 'projectId'>): Task {
  return {
    id: nextId('task'),
    phaseId: null,
    parentTaskId: null,
    title: 'Task',
    description: null,
    status: 'todo',
    priority: 'none',
    startDate: null,
    dueDate: null,
    sortOrder: 'a0',
    completedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  }
}

export function makeMilestone(
  overrides: Partial<Milestone> & Pick<Milestone, 'projectId' | 'date'>,
): Milestone {
  return {
    id: nextId('milestone'),
    phaseId: null,
    name: 'Milestone',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  }
}

export function makeDependency(
  overrides: Partial<Dependency> & Pick<Dependency, 'projectId' | 'predecessorId' | 'successorId'>,
): Dependency {
  return { id: nextId('dependency'), type: 'FS', createdAt: CREATED_AT, ...overrides }
}

function byId<T extends { id: string }>(rows: readonly T[] = []): Record<string, T> {
  return Object.fromEntries(rows.map((row) => [row.id, row]))
}

export function makeWorkspace(rows: {
  projects?: Project[]
  phases?: Phase[]
  tasks?: Task[]
  milestones?: Milestone[]
  dependencies?: Dependency[]
}): WorkspaceData {
  return {
    projects: byId(rows.projects),
    phases: byId(rows.phases),
    tasks: byId(rows.tasks),
    milestones: byId(rows.milestones),
    dependencies: byId(rows.dependencies),
  }
}

/** Deterministic PRNG (mulberry32) for property-style tests. Returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
