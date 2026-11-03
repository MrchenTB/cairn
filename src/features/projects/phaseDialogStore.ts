/** Open state of the "New phase" dialog (rendered once by ProjectLayout). */
import { create } from 'zustand'

interface PhaseDialogState {
  /** The project the new phase goes into; null = closed. */
  projectId: string | null
  open(projectId: string): void
  close(): void
}

export const usePhaseDialog = create<PhaseDialogState>()((set) => ({
  projectId: null,
  open: (projectId) => set({ projectId }),
  close: () => set({ projectId: null }),
}))
