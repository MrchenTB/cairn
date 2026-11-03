/**
 * Milestone create/edit dialog, mounted once by the app shell; open state is
 * `useUIStore().milestoneDialog` ({ mode: 'create', projectId, phaseId?, date? } |
 * { mode: 'edit', milestoneId }). Milestones are single-day markers that never count toward
 * progress.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useUIStore, type MilestoneDialogState } from '@/app/uiStore'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useMilestone, useWorkspaceStatus } from '@/data/hooks'
import {
  ignoreEscapeWhileComposing,
  ignorePointerDownOnToasts,
  returnFocusAfterClose,
} from '@/features/task-modal/dialogGuards'
import { getFocusReturnTarget } from '@/lib/focus'
import { notify } from '@/lib/notify'
import { MilestoneForm, type MilestoneFormControls } from './MilestoneForm'

const stateKeys = new WeakMap<MilestoneDialogState, string>()
let stateSequence = 0

/** Stable key per open request (each openMilestoneDialog call passes a new state object). */
function stateKey(state: MilestoneDialogState): string {
  let key = stateKeys.get(state)
  if (!key) {
    stateSequence += 1
    key = `milestone-dialog-${stateSequence}`
    stateKeys.set(state, key)
  }
  return key
}

export function MilestoneDialogHost() {
  const state = useUIStore((s) => s.milestoneDialog)
  const close = useUIStore((s) => s.closeMilestoneDialog)
  const milestone = useMilestone(state?.mode === 'edit' ? state.milestoneId : null)
  const { status } = useWorkspaceStatus()

  const open = state !== null && (state.mode === 'create' || milestone !== undefined)

  // Keep the last state rendered while the dialog animates out.
  const [shown, setShown] = useState<{ state: MilestoneDialogState; key: string } | null>(null)
  if (open && state && shown?.state !== state) {
    setShown({ state, key: stateKey(state) })
  }

  const controlsRef = useRef<MilestoneFormControls | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)
  const deletingRef = useRef<string | null>(null)

  // What had focus when the dialog opened (for a closing menu's item: the menu's trigger).
  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) openerRef.current = getFocusReturnTarget()
    wasOpenRef.current = open
  }, [open])

  // Editing a milestone that no longer exists (deleted elsewhere, stale state).
  useEffect(() => {
    if (state?.mode !== 'edit' || milestone || status !== 'ready') return
    if (deletingRef.current !== state.milestoneId) {
      notify.error('Milestone not found', {
        id: 'milestone-not-found',
        description: 'It may have been deleted.',
      })
    }
    close()
  }, [state, milestone, status, close])

  const restoreFocus = useCallback(() => {
    const opener = openerRef.current
    openerRef.current = null
    returnFocusAfterClose(opener)
  }, [])

  const current = shown?.state ?? null
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return
        if (controlsRef.current) controlsRef.current.requestClose()
        else close()
      }}
    >
      {current ? (
        <DialogContent
          size="sm"
          className="max-w-[460px]"
          onPointerDownOutside={ignorePointerDownOnToasts}
          onEscapeKeyDown={ignoreEscapeWhileComposing}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreFocus()
          }}
        >
          <MilestoneForm
            key={shown?.key}
            state={current}
            controlsRef={controlsRef}
            onClose={close}
            onDeleting={(milestoneId) => {
              deletingRef.current = milestoneId
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
