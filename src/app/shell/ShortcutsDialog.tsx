import { useMemo } from 'react'
import { Shortcut } from '@/components/ui/kbd'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useRegisteredHotkeys, type RegisteredHotkey } from '@/lib/keyboard'
import { useUIStore } from '../uiStore'

const GROUP_ORDER = ['General', 'Navigation', 'Current view']

/** Esc is handled by every overlay itself, so it is listed statically. */
const STATIC: RegisteredHotkey[] = [
  { id: -1, keys: ['escape'], description: 'Close dialog or menu', group: 'General' },
]

/** "?" help: every shortcut that is active right now, grouped (view shortcuts included). */
export function ShortcutsDialog() {
  const open = useUIStore((s) => s.shortcutsOpen)
  const setOpen = useUIStore((s) => s.setShortcutsOpen)
  const registered = useRegisteredHotkeys()

  const groups = useMemo(() => {
    const byGroup = new Map<string, RegisteredHotkey[]>()
    const seen = new Set<string>()
    for (const hotkey of [...registered, ...STATIC]) {
      const signature = `${hotkey.group}|${hotkey.description}|${hotkey.keys.join(',')}`
      if (seen.has(signature)) continue
      seen.add(signature)
      byGroup.set(hotkey.group, [...(byGroup.get(hotkey.group) ?? []), hotkey])
    }
    return [...byGroup.entries()].sort(([a], [b]) => {
      const rank = (name: string) => {
        const index = GROUP_ORDER.indexOf(name)
        return index === -1 ? GROUP_ORDER.length : index
      }
      return rank(a) - rank(b)
    })
  }, [registered])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        size="md"
        // Read-only content: focus the panel itself instead of ringing the close button.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement).focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts don’t fire while you’re typing in a field.</DialogDescription>
        </DialogHeader>
        <DialogBody className="pb-5">
          <div className="grid gap-5 sm:grid-cols-2">
            {groups.map(([group, hotkeys]) => (
              <section key={group} aria-label={group}>
                <h3 className="mb-1 flex h-7 items-center text-meta font-semibold text-fg-tertiary">
                  {group}
                </h3>
                <ul className="flex flex-col">
                  {hotkeys.map((hotkey) => (
                    <li
                      key={`${hotkey.id}-${hotkey.description}`}
                      className="flex h-8 items-center justify-between gap-3 text-ui text-fg-secondary"
                    >
                      <span className="truncate">{hotkey.description}</span>
                      <Shortcut keys={hotkey.keys[0]} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
