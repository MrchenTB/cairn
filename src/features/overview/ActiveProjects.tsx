import { Link } from 'react-router'
import { ProgressBar } from '@/components/task/ProgressBar'
import { ProjectDot } from '@/components/task/ProjectDot'
import { formatDate, formatDateSmart } from '@/domain/dates'
import type { ProgressInfo } from '@/domain/progress'
import type { ISODate, Project } from '@/domain/types'
import { cn } from '@/lib/utils'
import { ACTIVE_PROJECTS_LIMIT } from './overviewModel'
import { OverviewSection, SectionEmpty, SectionLink } from './OverviewSection'

const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_9.5rem_8rem] items-center gap-4'

export interface ActiveProjectsProps {
  /** Active projects in the user's project order. */
  projects: readonly Project[]
  progress: Record<string, ProgressInfo>
  today: ISODate
  /** Some projects exist but none is active (completed / archived only). */
  hasOtherProjects: boolean
}

/**
 * Dense rows of active projects: colour, name (links to the project), leaf-task progress — or
 * "No tasks", never a fake 100% — and the due date. At most ACTIVE_PROJECTS_LIMIT rows.
 */
export function ActiveProjects({
  projects,
  progress,
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

function ProjectRow({
  project,
  progress,
  today,
}: {
  project: Project
  progress: ProgressInfo | undefined
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
          className={cn(
            'max-w-[70%] min-w-0 shrink-0 truncate font-medium text-fg',
            // The link covers the row: one tab stop, the whole row is the click target.
            'after:absolute after:inset-0 after:rounded-md after:content-[""] focus-visible:outline-none',
            'focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus',
          )}
        >
          {project.name}
        </Link>
        {project.description ? (
          <span className="min-w-0 truncate text-fg-tertiary">{project.description}</span>
        ) : null}
      </div>
      <ProgressBar
        value={progress?.percent ?? null}
        done={progress?.done}
        total={progress?.total}
        aria-label={`${project.name} progress`}
        barClassName="w-20"
      />
      <span className="truncate text-right text-meta text-fg-tertiary tabular-nums">
        {project.dueDate ? (
          <span title={`Due ${formatDate(project.dueDate, 'medium')}`}>
            Due {formatDateSmart(project.dueDate, today)}
          </span>
        ) : (
          <>
            <span aria-hidden>—</span>
            <span className="sr-only">No due date</span>
          </>
        )}
      </span>
    </li>
  )
}
