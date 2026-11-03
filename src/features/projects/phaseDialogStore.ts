/** Open state of the "New phase" dialog (rendered once by ProjectLayout). */
import { create } from 'zustand'

interface PhaseDialogState {
  /** The project the new phase goes into; null = closed. */
  projectId: string | null
  /** Bumped on every open, so each opening starts a fresh form. */
  session: number
  open(projectId: string): void
  close(): void
}

export const usePhaseDialog = create<PhaseDialogState>()((set) => ({
  projectId: null,
  session: 0,
  open: (projectId) => set((state) => ({ projectId, session: state.session + 1 })),
  close: () => set({ projectId: null }),
}))
