import { Link } from 'react-router'
import { ProjectDot } from '@/components/task/ProjectDot'
import { formatDate, formatDateSmart } from '@/domain/dates'
import type { ISODate, Milestone, Project } from '@/domain/types'
import { cn } from '@/lib/utils'
import { MilestoneGlyph } from './MilestoneGlyph'
import { MILESTONE_WINDOW_DAYS, UPCOMING_MILESTONES_LIMIT } from './overviewModel'
import { OverviewSection, SectionEmpty, SectionLink } from './OverviewSection'

export interface UpcomingMilestonesProps {
  /** Milestones of the next 30 days, by date (`upcomingMilestones()`). */
  milestones: readonly Milestone[]
  projects: Record<string, Project>
  today: ISODate
}

/** Diamond, name, project and date; a row opens the project's Gantt (where milestones live). */
export function UpcomingMilestones({ milestones, projects, today }: UpcomingMilestonesProps) {
  const shown = milestones.slice(0, UPCOMING_MILESTONES_LIMIT)
  const more = milestones.length - shown.length
  return (
    <OverviewSection
      title="Upcoming milestones"
      count={milestones.length}
      hint={`Next ${MILESTONE_WINDOW_DAYS} days`}
    >
      {shown.length === 0 ? (
        <SectionEmpty
          title={`No milestones in the next ${MILESTONE_WINDOW_DAYS} days`}
          description="Add milestones to a project to mark deadlines and launches."
        />
      ) : (
        <>
          <ul aria-label="Upcoming milestones" className="flex flex-col">
            {shown.map((milestone) => (
              <MilestoneRow
                key={milestone.id}
                milestone={milestone}
                project={Object.hasOwn(projects, milestone.projectId) ? projects[milestone.projectId] : undefined}
                today={today}
              />
            ))}
          </ul>
          {more > 0 ? (
            <div className="mt-1 flex items-center justify-between gap-3 text-meta text-fg-tertiary">
              <span className="tabular-nums">
                Showing {shown.length} of {milestones.length}
              </span>
              <SectionLink to="/timeline">Open Timeline</SectionLink>
            </div>
          ) : null}
        </>
      )}
    </OverviewSection>
  )
}

function MilestoneRow({
  milestone,
  project,
  today,
}: {
  milestone: Milestone
  project: Project | undefined
  today: ISODate
}) {
  const detailsId = `milestone-row-${milestone.id}`
  const isToday = milestone.date === today
  return (
    <li
      className={cn(
        'relative -mx-3 flex h-9 items-center gap-2 rounded-md px-3 text-ui',
        'transition-colors duration-fast hover:bg-hover hover:duration-instant',
      )}
    >
      <span className="grid size-6 shrink-0 place-items-center">
        <MilestoneGlyph className="text-(--gantt-milestone)" />
      </span>
      <Link
        to={`/projects/${milestone.projectId}/gantt`}
        aria-describedby={detailsId}
        className={cn(
          'min-w-0 flex-1 truncate text-fg',
          'after:absolute after:inset-0 after:rounded-md after:content-[""] focus-visible:outline-none',
          'focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus',
        )}
      >
        {milestone.name}
      </Link>
      <span id={detailsId} className="flex shrink-0 items-center gap-3">
        {project ? (
          <span className="flex w-36 min-w-0 items-center gap-2 text-meta text-fg-secondary">
            <ProjectDot color={project.color} />
            <span className="min-w-0 truncate">{project.name}</span>
          </span>
        ) : null}
        <span
          title={formatDate(milestone.date, 'long')}
          className={cn(
            'w-20 text-right text-meta tabular-nums',
            isToday ? 'font-medium text-fg' : 'text-fg-tertiary',
          )}
        >
          <span className="sr-only">, </span>
          {formatDateSmart(milestone.date, today)}
        </span>
      </span>
    </li>
  )
}
