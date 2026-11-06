/** Small formatting helpers shared by the Settings sections. */
import type { BackupData, ImportSummary } from '@/domain/types'

const DAY_MS = 86_400_000

const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const dayTimeFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const fullFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })

/** A moment in the device's own time zone: 'Today, 3:42 PM' · 'Nov 1, 9:05 AM'. */
export function formatMoment(epochMs: number, now: number = Date.now()): string {
  const moment = new Date(epochMs)
  return new Date(now).toDateString() === moment.toDateString()
    ? `Today, ${timeFormat.format(moment)}`
    : dayTimeFormat.format(moment)
}

/** An ISO timestamp as 'Nov 2, 2026, 3:04 PM' (device time zone); the raw text when unparsable. */
export function formatTimestamp(iso: string): string {
  const moment = new Date(iso)
  return Number.isNaN(moment.getTime()) ? iso : fullFormat.format(moment)
}

/** 'just now' · 'today' · 'yesterday' · '5 days ago' · '3 weeks ago' · '4 months ago'. */
export function describeAge(then: number, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - then)
  if (elapsed < 60_000) return 'just now'
  const days = Math.floor(elapsed / DAY_MS)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  return `${Math.floor(days / 30)} months ago`
}

/** '1 task' · '2 tasks'; pass `pluralNoun` when it is not the noun plus "s" ('dependencies'). */
export function plural(count: number, noun: string, pluralNoun: string = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`
}

const COUNT_NOUNS: readonly [keyof ImportSummary, string, string][] = [
  ['projects', 'project', 'projects'],
  ['phases', 'phase', 'phases'],
  ['tasks', 'task', 'tasks'],
  ['milestones', 'milestone', 'milestones'],
  ['dependencies', 'dependency', 'dependencies'],
]

/** Row counts of a backup (or an import result) from its tables. */
export function countRows(data: BackupData | ImportSummary): ImportSummary {
  const count = (value: unknown) => (Array.isArray(value) ? value.length : Number(value) || 0)
  return {
    projects: count(data.projects),
    phases: count(data.phases),
    tasks: count(data.tasks),
    milestones: count(data.milestones),
    dependencies: count(data.dependencies),
  }
}

/** '2 projects, 14 tasks and 1 milestone' (empty tables left out); 'nothing' for none. */
export function describeCounts(summary: ImportSummary): string {
  const parts = COUNT_NOUNS.filter(([key]) => summary[key] > 0).map(([key, noun, nouns]) =>
    plural(summary[key], noun, nouns),
  )
  if (parts.length === 0) return 'nothing'
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}
