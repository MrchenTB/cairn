/**
 * Rows of the search overlay: the project / task / milestone results (matched part of the title
 * emphasised) and the shared bits they are made of. A row carries the context the user needs to
 * tell similar results apart: project, parent task, status, due date, archived state.
 */
import { Fragment, useMemo, type ComponentType, type ReactNode } from 'react'
import { Diamond } from 'lucide-react'
import { DueLabel } from '@/components/task/DueLabel'
import { ProjectDot } from '@/components/task/ProjectDot'
import { ProjectStatusBadge } from '@/components/task/ProjectStatusBadge'
import { StatusIcon } from '@/components/task/StatusIcon'
import { STATUS_LABELS } from '@/components/task/labels'
import { CommandItem, CommandShortcut } from '@/components/ui/command'
import { useToday } from '@/data/hooks'
import { formatDateSmart } from '@/domain/dates'
import type { SearchResult } from '@/domain/search'
import type { Project } from '@/domain/types'
import { matchSnippet, splitHighlight } from './highlight'
import type { MilestoneHit, ProjectHit, TaskHit } from './results'

/** `text` with the parts matched by `query` set in the primary colour / semibold. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const segments = useMemo(() => splitHighlight(text, query), [text, query])
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <span key={index} data-match className="font-semibold text-fg">
            {segment.text}
          </span>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  )
}

/**
 * A row's text: the title line and, when the title does not show why the row matched (the match
 * is in the description), a quiet excerpt of the description under it with the match emphasised.
 */
function RowText({
  children,
  snippet,
  query,
}: {
  children: ReactNode
  snippet: string | null
  query: string
}) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate">{children}</span>
      {snippet ? (
        <span data-snippet className="block truncate text-meta text-fg-tertiary">
          <Highlight text={snippet} query={query} />
        </span>
      ) : null}
    </span>
  )
}

/** Rows with an excerpt are two lines tall. */
const TALL_ROW = 'h-auto min-h-9 py-1.5'

/** Fixed 16px glyph column so every row's title starts at the same x. */
function Glyph({ children }: { children: ReactNode }) {
  return <span className="flex size-4 shrink-0 items-center justify-center">{children}</span>
}

/** Right-hand meta cluster of a row. */
function Meta({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto flex min-w-0 shrink-0 items-center gap-3 pl-3 text-meta text-fg-tertiary">
      {children}
    </span>
  )
}

/** Project colour dot + name, with an "Archived" label when the project is archived. */
function ProjectContext({ project }: { project: Project }) {
  return (
    <span className="flex min-w-0 max-w-40 items-center gap-1.5">
      <ProjectDot color={project.color} size={8} />
      <span className="truncate">{project.name}</span>
      {project.status === 'archived' ? <ProjectStatusBadge status="archived" size="sm" /> : null}
    </span>
  )
}

interface RowProps<T extends SearchResult> {
  hit: T
  query: string
  onOpen: (result: SearchResult) => void
}

export function ProjectRow({ hit, query, onOpen }: RowProps<ProjectHit>) {
  const { project } = hit
  const snippet = useMemo(
    () => matchSnippet(project.name, project.description, query),
    [project.name, project.description, query],
  )
  return (
    <CommandItem
      value={`project:${project.id}`}
      data-kind="project"
      className={snippet ? TALL_ROW : undefined}
      onSelect={() => onOpen(hit)}
    >
      <Glyph>
        <ProjectDot color={project.color} size={10} />
      </Glyph>
      <RowText snippet={snippet} query={query}>
        <Highlight text={project.name} query={query} />
      </RowText>
      {project.status !== 'active' ? (
        <ProjectStatusBadge status={project.status} size="sm" />
      ) : null}
    </CommandItem>
  )
}

export function TaskRow({ hit, query, onOpen }: RowProps<TaskHit>) {
  const { task, project, parent } = hit
  const snippet = useMemo(
    () => matchSnippet(task.title, task.description, query),
    [task.title, task.description, query],
  )
  return (
    <CommandItem
      value={`task:${task.id}`}
      data-kind="task"
      className={snippet ? TALL_ROW : undefined}
      onSelect={() => onOpen(hit)}
    >
      <Glyph>
        <StatusIcon status={task.status} decorative />
      </Glyph>
      <RowText snippet={snippet} query={query}>
        <Highlight text={task.title} query={query} />
        {parent ? <span className="ml-2 text-meta text-fg-tertiary">in {parent.title}</span> : null}
        <span className="sr-only">, {STATUS_LABELS[task.status]}</span>
      </RowText>
      <Meta>
        <ProjectContext project={project} />
        <DueLabel dueDate={task.dueDate} status={task.status} />
      </Meta>
    </CommandItem>
  )
}

export function MilestoneRow({ hit, query, onOpen }: RowProps<MilestoneHit>) {
  const { milestone, project } = hit
  const today = useToday()
  return (
    <CommandItem
      value={`milestone:${milestone.id}`}
      data-kind="milestone"
      onSelect={() => onOpen(hit)}
    >
      <Glyph>
        <Diamond className="size-3.5 text-fg-tertiary" />
      </Glyph>
      <span className="min-w-0 flex-1 truncate">
        <Highlight text={milestone.name} query={query} />
        <span className="sr-only">, milestone</span>
      </span>
      <Meta>
        <ProjectContext project={project} />
        <span className="whitespace-nowrap tabular-nums">
          {formatDateSmart(milestone.date, today)}
        </span>
      </Meta>
    </CommandItem>
  )
}

/** A recently visited project in the empty-query list. */
export function RecentProjectRow({
  project,
  onOpen,
}: {
  project: Project
  onOpen: (project: Project) => void
}) {
  return (
    <CommandItem value={`recent:${project.id}`} data-kind="recent" onSelect={() => onOpen(project)}>
      <Glyph>
        <ProjectDot color={project.color} size={10} />
      </Glyph>
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
    </CommandItem>
  )
}

/** A quick action in the empty-query list (icon, label, optional shortcut or hint on the right). */
export function ActionRow({
  value,
  icon: Icon,
  label,
  shortcut,
  hint,
  onSelect,
}: {
  value: string
  icon: ComponentType<{ className?: string }>
  label: string
  /** Shown as key caps (keyboard-engine syntax, e.g. 'g o'). */
  shortcut?: ReactNode
  hint?: string
  onSelect: () => void
}) {
  return (
    <CommandItem value={value} data-kind="action" onSelect={onSelect}>
      <Icon className="text-fg-tertiary" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut || hint ? <CommandShortcut>{shortcut ?? hint}</CommandShortcut> : null}
    </CommandItem>
  )
}
