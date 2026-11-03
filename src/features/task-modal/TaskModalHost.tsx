/**
 * The Task Modal (PRD §4.9), mounted once by the app shell.
 * - EDIT mode: `?task=<id>` on any route (useTaskParam). An unknown or deleted id reports
 *   "Task not found" and removes the param.
 * - CREATE mode: `useUIStore().newTask` (defaults from the opener).
 * One centred Radix dialog hosts either form. Esc, overlay click and the close button ask the
 * active form first (unsaved changes → "Discard changes?"); focus returns to the element that
 * opened the modal.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCloseTask, useOpenTask, useTaskParam } from '@/app/taskModalRoute'
import { useUIStore, type NewTaskDefaults } from '@/app/uiStore'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useProjects, useTask, useWorkspaceStatus } from '@/data/hooks'
import type { Task } from '@/domain/types'
import { notify } from '@/lib/notify'
import {
  defaultsWithDraft,
  rememberDraftForProjectCreate,
  takePendingProjectCreate,
} from './createSupport'
import { CreateTaskForm } from './CreateTaskForm'
import { ignorePointerDownOnToasts } from './dialogGuards'
import { EditTaskForm } from './EditTaskForm'
import type { TaskFormValues } from './formModel'
import { isSaveShortcut } from './keys'
import type { ModalControls } from './modalControls'

type Session = { kind: 'create'; defaults: NewTaskDefaults } | { kind: 'edit'; taskId: string }

interface ShownSession {
  session: Session
  key: string
}

const createKeys = new WeakMap<NewTaskDefaults, string>()
let createSequence = 0

/** Stable key per create request (each openNewTask call passes a new defaults object). */
function createKey(defaults: NewTaskDefaults): string {
  let key = createKeys.get(defaults)
  if (!key) {
    createSequence += 1
    key = `create-${createSequence}`
    createKeys.set(defaults, key)
  }
  return key
}

function sessionKey(session: Session): string {
  return session.kind === 'edit' ? `edit-${session.taskId}` : createKey(session.defaults)
}

/**
 * Runs `callback` once no dialog is on screen any more (exit animations included), checking
 * every frame, at most `timeoutMs` later. Returns a cancel function.
 */
function afterDialogsClosed(callback: () => void, timeoutMs = 1000): () => void {
  const startedAt = performance.now()
  let frame = 0
  const tick = () => {
    const open = document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
    if (open && performance.now() - startedAt < timeoutMs) {
      frame = requestAnimationFrame(tick)
      return
    }
    frame = 0
    callback()
  }
  frame = requestAnimationFrame(tick)
  return () => {
    if (frame) cancelAnimationFrame(frame)
  }
}

export function TaskModalHost() {
  const taskParam = useTaskParam()
  const newTask = useUIStore((s) => s.newTask)
  const closeNewTask = useUIStore((s) => s.closeNewTask)
  const openProjectDialog = useUIStore((s) => s.openProjectDialog)
  const closeTask = useCloseTask()
  const openTask = useOpenTask()
  const task = useTask(taskParam)
  const allProjects = useProjects({ includeArchived: true })
  const { status } = useWorkspaceStatus()

  // Create is opened explicitly on top of whatever page (or task) is showing, so it wins.
  const session: Session | null = newTask
    ? { kind: 'create', defaults: newTask }
    : taskParam
      ? { kind: 'edit', taskId: taskParam }
      : null
  const open = session !== null && (session.kind === 'create' || task !== undefined)

  // Keep the last session rendered while the dialog animates out.
  const [shown, setShown] = useState<ShownSession | null>(null)
  if (open && session && shown?.key !== sessionKey(session)) {
    setShown({ session, key: sessionKey(session) })
  }

  const controlsRef = useRef<ModalControls | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)
  /** A task this modal is deleting: its disappearance is expected, not "not found". */
  const deletingRef = useRef<string | null>(null)
  const reportedMissingRef = useRef<string | null>(null)
  const openTaskRef = useRef(openTask)
  const projectsRef = useRef(allProjects)

  useLayoutEffect(() => {
    openTaskRef.current = openTask
    projectsRef.current = allProjects
  })

  // Remember what had focus when the modal opened (before Radix moves focus into it).
  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = document.activeElement
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
    }
    wasOpenRef.current = open
  }, [open])

  // ?task=<id> for a task that does not exist (any more).
  useEffect(() => {
    if (!taskParam) {
      reportedMissingRef.current = null
      deletingRef.current = null
      return
    }
    if (task || status !== 'ready') return
    if (deletingRef.current !== taskParam && reportedMissingRef.current !== taskParam) {
      reportedMissingRef.current = taskParam
      notify.error('Task not found', {
        id: 'task-not-found',
        description: 'It may have been deleted, or the link is incomplete.',
      })
    }
    closeTask()
  }, [taskParam, task, status, closeTask])

  // "Create project" from an empty workspace: reopen New task for the new project afterwards.
  useEffect(() => {
    let cancel: (() => void) | null = null
    const unsubscribe = useUIStore.subscribe((state, previous) => {
      if (previous.projectDialog?.mode !== 'create' || state.projectDialog !== null) return
      const pending = takePendingProjectCreate()
      if (!pending) return
      cancel?.()
      // Wait until the project dialog has finished closing: while its focus scope is still
      // mounted, the page it navigates to could take focus from the reopened modal.
      cancel = afterDialogsClosed(() => {
        cancel = null
        const created = projectsRef.current.find(
          (project) => !pending.knownProjectIds.has(project.id) && project.status !== 'archived',
        )
        if (!created) return
        useUIStore
          .getState()
          .openNewTask(defaultsWithDraft(pending.defaults, created.id, pending.draft))
      })
    })
    return () => {
      unsubscribe()
      cancel?.()
    }
  }, [])

  const closeEdit = useCallback(() => closeTask(), [closeTask])

  const handleCreated = useCallback((created: Task) => {
    notify.success('Task created', {
      description: created.title,
      action: { label: 'Open', onClick: () => openTaskRef.current(created.id) },
    })
  }, [])

  const handleCreateProject = useCallback(
    (defaults: NewTaskDefaults, draft: TaskFormValues) => {
      rememberDraftForProjectCreate({
        knownProjectIds: new Set(projectsRef.current.map((project) => project.id)),
        defaults,
        draft,
      })
      closeNewTask()
      openProjectDialog({ mode: 'create' })
    },
    [closeNewTask, openProjectDialog],
  )

  const restoreFocus = () => {
    const opener = openerRef.current
    openerRef.current = null
    if (opener?.isConnected) {
      opener.focus({ preventScroll: true })
      return
    }
    document.getElementById('main')?.focus({ preventScroll: true })
  }

  const current = shown?.session ?? null
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return
        if (controlsRef.current) controlsRef.current.requestClose()
        else if (current?.kind === 'create') closeNewTask()
        else closeTask()
      }}
    >
      {current ? (
        <DialogContent
          size="lg"
          position="top"
          showClose={false}
          aria-describedby={undefined}
          className="max-w-[680px]"
          // The form focuses its title itself.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onPointerDownOutside={ignorePointerDownOnToasts}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreFocus()
          }}
          // ⌘↵ / Ctrl+↵ saves from anywhere in the modal (its menus and popovers included).
          onKeyDown={(event) => {
            if (!isSaveShortcut(event)) return
            event.preventDefault()
            controlsRef.current?.submit()
          }}
        >
          {current.kind === 'create' ? (
            <CreateTaskForm
              key={shown?.key}
              defaults={current.defaults}
              controlsRef={controlsRef}
              onClose={closeNewTask}
              onCreated={handleCreated}
              onCreateProject={(draft) => handleCreateProject(current.defaults, draft)}
            />
          ) : (
            <EditTaskForm
              key={shown?.key}
              taskId={current.taskId}
              controlsRef={controlsRef}
              onClose={closeEdit}
              onDeleting={(taskId) => {
                deletingRef.current = taskId
              }}
            />
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
