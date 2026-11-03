/**
 * Imperative confirmation dialogs.
 *
 *   if (await confirm({ title: 'Delete project?', description: 'Deletes 12 tasks…',
 *                       confirmLabel: 'Delete', destructive: true })) { … }
 *
 * `<ConfirmHost/>` is mounted once in the app shell. Requests are queued and shown one at a
 * time. Destructive confirmations focus Cancel first (design §5.8); others focus the action.
 */
import { useRef, useSyncExternalStore, type ReactNode } from 'react'
import { getFocusReturnTarget } from '@/lib/focus'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog'

export interface ConfirmOptions {
  title: string
  /** Say what will happen and its scope, e.g. "Deletes 12 tasks. This can't be undone." */
  description?: ReactNode
  /** Default "Confirm". */
  confirmLabel?: string
  /** Default "Cancel". */
  cancelLabel?: string
  /** Red action button and Cancel focused first. */
  destructive?: boolean
}

export interface Choice<T extends string> {
  value: T
  label: string
  variant?: 'primary' | 'secondary' | 'danger'
}

export interface ChooseOptions<T extends string> {
  title: string
  description?: ReactNode
  /** Rendered left → right after Cancel; put the safest choice first. */
  choices: readonly Choice<T>[]
  cancelLabel?: string
}

interface ConfirmRequest {
  id: number
  title: string
  description?: ReactNode
  cancelLabel: string
  choices: readonly Choice<string>[]
  focusCancel: boolean
  open: boolean
  resolve: (value: string | null) => void
  /** Where focus goes back when the dialog closes (it has no trigger for Radix to use). */
  returnFocus: HTMLElement | null
}

/**
 * The element that had focus when a request was made. A menu item is about to disappear (the menu
 * closes), so its menu's trigger is used instead.
 */
function focusToRestore(): HTMLElement | null {
  return typeof document === 'undefined' ? null : getFocusReturnTarget()
}

/** Matches the dialog exit animation so the panel keeps its content while fading out. */
const EXIT_MS = 200

let nextId = 1
let queue: ConfirmRequest[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function enqueue(
  request: Omit<ConfirmRequest, 'id' | 'open' | 'resolve' | 'returnFocus'>,
): Promise<string | null> {
  return new Promise((resolve) => {
    queue = [
      ...queue,
      { ...request, id: nextId++, open: true, resolve, returnFocus: focusToRestore() },
    ]
    emit()
  })
}

function settle(id: number, value: string | null) {
  const request = queue.find((r) => r.id === id)
  if (!request || !request.open) return
  request.resolve(value)
  queue = queue.map((r) => (r.id === id ? { ...r, open: false } : r))
  emit()
  setTimeout(() => {
    queue = queue.filter((r) => r.id !== id)
    emit()
  }, EXIT_MS)
}

/** Asks a yes/no question. Resolves true on confirm, false on cancel / Esc. */
// oxlint-disable-next-line react/only-export-components -- imperative API lives with its host
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return enqueue({
    title: options.title,
    description: options.description,
    cancelLabel: options.cancelLabel ?? 'Cancel',
    choices: [
      {
        value: 'confirm',
        label: options.confirmLabel ?? 'Confirm',
        variant: options.destructive ? 'danger' : 'primary',
      },
    ],
    focusCancel: options.destructive ?? false,
  }).then((value) => value === 'confirm')
}

/**
 * Asks the user to pick one of several actions (e.g. "Delete subtasks too" vs "Keep subtasks").
 * Resolves the chosen value, or null when cancelled.
 */
// oxlint-disable-next-line react/only-export-components -- imperative API lives with its host
export function choose<T extends string>(options: ChooseOptions<T>): Promise<T | null> {
  return enqueue({
    title: options.title,
    description: options.description,
    cancelLabel: options.cancelLabel ?? 'Cancel',
    choices: options.choices,
    focusCancel: options.choices.some((c) => c.variant === 'danger'),
  }) as Promise<T | null>
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function getSnapshot(): ConfirmRequest | null {
  return queue[0] ?? null
}

/** Renders queued confirm()/choose() requests. Mount exactly once. */
export function ConfirmHost() {
  const current = useSyncExternalStore(subscribe, getSnapshot, () => null)
  const lastActionRef = useRef<HTMLButtonElement>(null)

  return (
    <AlertDialog
      open={current?.open ?? false}
      onOpenChange={(open) => {
        if (!open && current) settle(current.id, null)
      }}
    >
      {current ? (
        <AlertDialogContent
          // Several choices (choose()) need room for their labels on one row.
          className={current.choices.length > 1 ? 'max-w-[540px]' : undefined}
          onOpenAutoFocus={(event) => {
            if (current.focusCancel) return // Radix focuses Cancel by default
            event.preventDefault()
            lastActionRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            // No trigger: return focus to where the request came from, else stay inside the
            // dialog underneath (e.g. a modal that asked "Discard changes?").
            const target =
              current.returnFocus?.isConnected === true
                ? current.returnFocus
                : document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]')
            if (!target) return
            event.preventDefault()
            target.focus({ preventScroll: true })
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{current.title}</AlertDialogTitle>
            {current.description ? (
              <AlertDialogDescription>{current.description}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{current.cancelLabel}</AlertDialogCancel>
            {current.choices.map((choice, index) => (
              <AlertDialogAction
                key={choice.value}
                ref={index === current.choices.length - 1 ? lastActionRef : undefined}
                variant={choice.variant ?? 'secondary'}
                onClick={(event) => {
                  // Settle ourselves so the chosen value (not "cancel") wins.
                  event.preventDefault()
                  settle(current.id, choice.value)
                }}
              >
                {choice.label}
              </AlertDialogAction>
            ))}
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}
