/**
 * CONTRACT STUB — replaced by the data-layer implementation.
 * Exposes the final store shape so UI code compiles against it from day one.
 */
import { create } from 'zustand'
import type { Result } from '@/domain/types'
import type { AuthState, WorkspaceActions, WorkspaceState } from './contracts'
import { DEFAULT_PREFERENCES, EMPTY_WORKSPACE } from './defaults'

const notReady = async (): Promise<Result<never>> => ({
  ok: false,
  error: { kind: 'unknown', message: 'Data layer not implemented yet' },
})

const stubActions: WorkspaceActions = {
  load: notReady,
  refresh: notReady,
  reset: () => {},
  createProject: notReady,
  updateProject: notReady,
  deleteProject: notReady,
  moveProject: notReady,
  createPhase: notReady,
  updatePhase: notReady,
  deletePhase: notReady,
  movePhase: notReady,
  createTask: notReady,
  updateTask: notReady,
  moveTask: notReady,
  deleteTask: notReady,
  createMilestone: notReady,
  updateMilestone: notReady,
  deleteMilestone: notReady,
  addDependency: notReady,
  removeDependency: notReady,
  applySchedule: notReady,
  updatePreferences: notReady,
  exportBackup: () => ({
    app: 'cairn',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    data: { projects: [], phases: [], tasks: [], milestones: [], dependencies: [] },
    preferences: null,
  }),
  importBackup: notReady,
  retryLastFailed: notReady,
}

export const useWorkspaceStore = create<WorkspaceState>()(() => ({
  mode: 'local',
  status: 'idle',
  loadError: null,
  data: EMPTY_WORKSPACE,
  preferences: DEFAULT_PREFERENCES,
  sync: {
    pending: 0,
    lastError: null,
    lastSavedAt: null,
    lastLoadedAt: null,
    online: true,
    canRetry: false,
  },
  actions: stubActions,
}))

export const useAuthStore = create<AuthState>()(() => ({
  mode: 'local',
  status: 'signed_in',
  user: { id: 'local-user', email: null },
  actions: {
    init: async () => {},
    signIn: notReady,
    signUp: notReady,
    signOut: notReady,
    sendPasswordReset: notReady,
  },
}))

/** Non-hook access for event handlers and non-React modules. */
export const getWorkspaceActions = (): WorkspaceActions => useWorkspaceStore.getState().actions
