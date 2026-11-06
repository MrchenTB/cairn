import { PopoverClose } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { openTaskFromAnywhere } from '@/app/taskModalRoute'
import { taskDrafts } from '@/features/task-modal/autosave/taskDrafts'
import type { DraftSummary } from '@/features/task-modal/autosave/draftManager'
import { notify } from '@/lib/notify'

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    notify.success('Text copied')
  } catch {
    notify.error('Couldn’t copy the text')
  }
}

/**
 * Where text that could not be saved can be found again once its toast is gone: the task it belongs
 * to (Open shows the text in the field, with what to do next), or, when that task no longer exists,
 * a copy of the text.
 */
export function UnsavedDraftsList({ drafts }: { drafts: readonly DraftSummary[] }) {
  if (drafts.length === 0) return null
  return (
    <div className="mt-3 border-t border-subtle pt-2">
      <p className="text-meta font-medium text-fg-secondary">Unsaved text</p>
      <ul className="mt-1 flex flex-col gap-1">
        {drafts.map((draft) => (
          <li key={draft.key} className="flex min-w-0 items-center gap-1">
            <span className="flex min-w-0 flex-1 text-meta" title={draft.text}>
              <span className="truncate text-fg">{draft.taskTitle}</span>
              <span className="shrink-0 whitespace-pre text-fg-tertiary"> · {draft.field}</span>
            </span>
            {draft.taskExists ? (
              <PopoverClose asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={`Open “${draft.taskTitle}”`}
                  onClick={() => openTaskFromAnywhere(draft.taskId)}
                >
                  Open
                </Button>
              </PopoverClose>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                aria-label={`Copy the ${draft.field} of “${draft.taskTitle}”`}
                onClick={() => void copyText(draft.text)}
              >
                Copy
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Discard the unsaved ${draft.field} of “${draft.taskTitle}”`}
              onClick={() => taskDrafts.discardDraft(draft.taskId, draft.field)}
            >
              Discard
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
