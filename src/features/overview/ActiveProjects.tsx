import { Link } from 'react-router'
import { ProgressBar } from '@/components/task/ProgressBar'
import { ProjectDot } from '@/components/task/ProjectDot'
import { formatDate, formatDateRange, formatDateSmart } from '@/domain/dates'
import type { ProgressInfo } from '@/domain/progress'
import type { ISODate, Project } from '@/domain/types'
import { cn } from '@/lib/utils'
import type { TaskCounts } from '@/features/projects/projectStats'
import { ACTIVE_PROJECTS_LIMIT, type ProjectTiming } from './overviewModel'
import { OverviewSection, SectionEmpty, SectionLink } from './OverviewSection'

/**
 * Name | progress | open tasks | dates. The bar only appears when the section is wide enough for
 * it (container query on the page body); below that the percentage and the open count remain.
 */
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_2.5rem_4rem_10rem] items-center gap-3 @[40rem]:grid-cols-[minmax(0,1fr)_9.5rem_4.5rem_12rem] @[40rem]:gap-4'

export interface ActiveProjectsProps {
  /** Active projects in the user's project order. */
  projects: readonly Project[]
  progress: Record<string, ProgressInfo>
  /** Open / total tasks (any level) per project. */
  counts: Record<string, TaskCounts>
  /** The date each row shows (`projectTimings()`). */
  timings: Record<string, ProjectTiming>
  today: ISODate
  /** Some projects exist but none is active (completed / archived only). */
  hasOtherProjects: boolean
}

/**
 * Dense rows of active projects: colour, name (links to the project), leaf-task progress — or
 * "No tasks", never a fake 100% — the open task count and one date: the due date, or, without
 * one, the extent of its tasks marked "from tasks". At most ACTIVE_PROJECTS_LIMIT rows.
 */
export function ActiveProjects({
  projects,
  progress,
  counts,
  timings,
  today,
  hasOtherProjects,
}: ActiveProjectsProps) {
  const shown = projects.slice(0, ACTIVE_PROJECTS_LIMIT)
  const more = projects.length - shown.length
  return (
    <OverviewSection
      title="Active projects"
      count={projects.length}
      action={<SectionLink to="/projects">View all</SectionLink>}
    >
      {shown.length === 0 ? (
        <SectionEmpty
          title="No active projects"
          description={
            hasOtherProjects
              ? 'Completed and archived projects are on the Projects page.'
              : 'Projects you are working on show up here.'
          }
        />
      ) : (
        <>
          <ul aria-label="Active projects" className="flex flex-col">
            {shown.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                progress={progress[project.id]}
                counts={counts[project.id]}
                timing={timings[project.id] ?? NO_TIMING}
                today={today}
              />
            ))}
          </ul>
          {more > 0 ? (
            <Link
              to="/projects"
              className="mt-1 self-start rounded-sm text-meta text-fg-tertiary transition-colors duration-fast hover:text-fg hover:duration-instant"
            >
              +{more} more {more === 1 ? 'project' : 'projects'}
            </Link>
          ) : null}
        </>
      )}
    </OverviewSection>
  )
}

const NO_TIMING: ProjectTiming = { kind: 'none' }

function ProjectRow({
  project,
  progress,
  counts,
  timing,
  today,
}: {
  project: Project
  progress: ProgressInfo | undefined
  counts: TaskCounts | undefined
  timing: ProjectTiming
  today: ISODate
}) {
  return (
    <li
      className={cn(
        ROW_GRID,
        'relative -mx-3 h-9 rounded-md px-3 text-ui',
        'transition-colors duration-fast hover:bg-hover hover:duration-instant',
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <ProjectDot color={project.color} />
        <Link
          to={`/projects/${project.id}`}
          title={project.name}
          className={cn(
            'min-w-0 truncate font-medium text-fg',
            // The link covers the row: one tab stop, the whole row is the click target.
            'after:absolute after:inset-0 after:rounded-md after:content-[""] focus-visible:outline-none',
            'focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus',
          )}
        >
          {project.name}
        </Link>
        {project.description ? (
          // Gives way first: the name is only cut when the description is already gone.
          <span className="hidden min-w-0 shrink-[20] truncate text-fg-tertiary @[40rem]:inline">
            {project.description}
          </span>
        ) : null}
      </div>
      {progress && progress.percent !== null ? (
        <>
          <ProgressBar
            value={progress.percent}
            done={progress.done}
            total={progress.total}
            aria-label={`${project.name} progress`}
            barClassName="hidden w-20 @[40rem]:block"
            className="justify-end @[40rem]:justify-start"
          />
          <span className="text-right text-meta whitespace-nowrap text-fg-tertiary tabular-nums">
            {counts ? `${counts.open.toLocaleString('en-US')} open` : null}
          </span>
        </>
      ) : (
        <span className="col-span-2 text-meta whitespace-nowrap text-fg-tertiary">No tasks</span>
      )}
      <ProjectDates timing={timing} today={today} />
    </li>
  )
}

/** The row's date cell. Only a due date the user set reads as one; the rest is marked or empty. */
function ProjectDates({ timing, today }: { timing: ProjectTiming; today: ISODate }) {
  const cell = 'truncate text-right text-meta tabular-nums'
  switch (timing.kind) {
    case 'due':
      return (
        <span
          className={cn(cell, 'text-fg-secondary')}
          title={
            timing.start
              ? `${formatDate(timing.start, 'medium')} – ${formatDate(timing.due, 'medium')}`
              : `Due ${formatDate(timing.due, 'medium')}`
          }
        >
          Due {formatDateSmart(timing.due, today)}
        </span>
      )
    case 'derived':
      return (
        <span
          className={cn(cell, 'text-fg-tertiary')}
          title={`${formatDate(timing.start, 'medium')} – ${formatDate(timing.end, 'medium')}: worked out from this project’s ${timing.from === 'tasks' ? 'tasks and milestones' : 'milestones'}. No due date is set.`}
        >
          <span className="sr-only">No due date set. Dates run </span>
          {formatDateRange(timing.start, timing.end, today)}
          <span aria-hidden> · from {timing.from}</span>
          <span className="sr-only">
            , worked out from its {timing.from === 'tasks' ? 'tasks and milestones' : 'milestones'}
          </span>
        </span>
      )
    case 'starts':
      return (
        <span
          className={cn(cell, 'text-fg-tertiary')}
          title={`Starts ${formatDate(timing.start, 'medium')}. No due date is set.`}
        >
          {formatDateRange(timing.start, null, today)}
        </span>
      )
    case 'none':
      return <span className="sr-only">No dates</span>
  }
}
