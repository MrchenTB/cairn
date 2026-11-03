import { confirm } from '@/components/ui/confirm'

/** "Discard changes?" — resolves true when the user chooses to throw the edits away. */
export function confirmDiscard(): Promise<boolean> {
  return confirm({
    title: 'Discard changes?',
    description: 'Your changes to this task haven’t been saved.',
    confirmLabel: 'Discard',
    cancelLabel: 'Keep editing',
    destructive: true,
  })
}
