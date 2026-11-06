/**
 * Searchable time zone picker: a field-style button that opens a popover with a search input and
 * every IANA zone (with its UTC offset right now). Type "taipei" or "utc+8" to filter; ↑/↓ and
 * Enter pick, Esc closes. The saved zone is checked and scrolled into view when the list opens.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { fieldBase } from '@/components/ui/styles'
import { getBrowserTimeZone } from '@/domain/dates'
import { ignoreEscapeWhileComposing } from '@/features/task-modal/dialogGuards'
import { cn } from '@/lib/utils'
import { describeTimeZone, filterTimeZones, listTimeZones } from './timezones'

export function TimeZoneField({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (timeZone: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const current = useMemo(() => describeTimeZone(value), [value])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={`Time zone: ${current.name}, ${current.offset}`}
          className={cn(
            fieldBase,
            'flex h-8 items-center justify-between gap-2 text-left @md:w-80',
            className,
          )}
        >
          <span className="min-w-0 truncate">
            {current.name} <span className="text-fg-tertiary">{current.offset}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-fg-tertiary" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-80 p-0"
        // The Esc that cancels a CJK input-method composition must not close the picker.
        onEscapeKeyDown={ignoreEscapeWhileComposing}
      >
        <ZonePicker
          value={value}
          onPick={(timeZone) => {
            setOpen(false)
            if (timeZone !== value) onChange(timeZone)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** Mounted while the popover is open, so every opening starts with an empty search. */
function ZonePicker({ value, onPick }: { value: string; onPick: (timeZone: string) => void }) {
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  // The saved zone and the browser's zone are always offered, even if the runtime's list lacks them.
  const all = useMemo(() => listTimeZones(undefined, [value, getBrowserTimeZone()]), [value])
  const zones = useMemo(() => filterTimeZones(all, query), [all, query])

  useEffect(() => {
    const list = listRef.current
    const selected = list?.querySelector<HTMLElement>('[data-current="true"]')
    if (!list || !selected) return
    const above = selected.getBoundingClientRect().top - list.getBoundingClientRect().top
    list.scrollTop += above - (list.clientHeight - selected.offsetHeight) / 2
  }, [])

  // cmdk moves the selection to the first match when the query changes, but the list keeps its
  // scroll position (centred on the saved zone, or where cmdk last scrolled the old selection):
  // without this the first match stays out of sight. Same frame as cmdk's own scrolling.
  const shownQuery = useRef(query)
  useEffect(() => {
    if (shownQuery.current === query) return
    shownQuery.current = query
    const frame = requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = 0
    })
    return () => cancelAnimationFrame(frame)
  }, [query])

  return (
    <Command
      shouldFilter={false}
      loop
      vimBindings={false}
      label="Time zones"
      defaultValue={`zone:${value}`}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search time zones…"
        autoComplete="off"
        spellCheck={false}
      />
      <CommandList ref={listRef} className="max-h-72">
        <CommandEmpty>No time zone matches "{query.trim()}".</CommandEmpty>
        <CommandGroup>
          {zones.map((zone) => (
            <CommandItem
              key={zone.id}
              value={`zone:${zone.id}`}
              data-current={zone.id === value}
              onSelect={() => onPick(zone.id)}
            >
              <Check className={cn('size-4', zone.id === value ? 'opacity-100' : 'opacity-0')} />
              <span className="min-w-0 flex-1 truncate">{zone.name}</span>
              <CommandShortcut>{zone.offset}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}
