/**
 * "Next 6 weeks": a tiny, read-only cross-project timeline (PRD: no editable Gantt on the
 * dashboard). One thin row per active project with something in the window — its span (own
 * dates or the roll-up of its tasks and milestones), milestone diamonds and the today line.
 * Each row links to the project's Gantt; "Open Timeline" leads to the full view.
 */
import { Link } from 'react-router'
import { ProjectDot } from '@/components/task/ProjectDot'
import { formatDate, formatDateRange } from '@/domain/dates'
import type { ISODate } from '@/domain/types'
import { cn } from '@/lib/utils'
import { dayCenter, type MiniTimeline as MiniTimelineModel, type TimelineRow } from './overviewModel'
import { OverviewSection, SectionEmpty, SectionLink } from './OverviewSection'

const LABEL_COLUMN = 'w-44'
const LABEL_OFFSET = 'left-44'

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function MiniTimeline({ timeline, today }: { timeline: MiniTimelineModel; today: ISODate }) {
  const { window, rows, more, idle } = timeline
  const todayX = dayCenter(today, window)
  const range = formatDateRange(window.start, window.end, today)
  const notes = [
    more > 0 ? `${more} more in Timeline` : null,
    idle > 0
      ? `${plural(idle, 'active project')} with nothing scheduled in these weeks`
      : null,
  ].filter(Boolean)

  return (
    <OverviewSection
      title="Next 6 weeks"
      hint={range}
      action={<SectionLink to="/timeline">Open Timeline</SectionLink>}
    >
      {rows.length === 0 ? (
        <SectionEmpty
          title="Nothing scheduled in the next 6 weeks"
          description="Give projects, tasks or milestones dates to see them here."
        />
      ) : (
        <div className="relative">
          {/* Week columns (behind the rows). */}
          <div aria-hidden className={cn('pointer-events-none absolute inset-y-0 right-0', LABEL_OFFSET)}>
            {window.weeks.map((week, index) => (
              <span
                key={week}
                className="absolute inset-y-0 w-px bg-(--gantt-grid-strong)"
                style={{ left: `${(index / window.weeks.length) * 100}%` }}
              />
            ))}
          </div>
          {/* Week labels. */}
          <div aria-hidden className="flex h-6 items-end">
            <span className={cn('shrink-0', LABEL_COLUMN)} />
            <div className="relative h-full flex-1">
              {window.weeks.map((week, index) => (
                <span
                  key={week}
                  className="absolute bottom-1 pl-1.5 text-micro whitespace-nowrap text-fg-tertiary tabular-nums"
                  style={{ left: `${(index / window.weeks.length) * 100}%` }}
                >
                  {formatDate(week, 'short')}
                </span>
              ))}
            </div>
          </div>
          <ul aria-label={`Projects, ${range}`} className="flex flex-col pb-1">
            {rows.map((row) => (
              <TimelineRowItem key={row.project.id} row={row} today={today} timeline={timeline} />
            ))}
          </ul>
          {/* Today line (above the bars). */}
          {todayX !== null ? (
            <div aria-hidden className={cn('pointer-events-none absolute inset-y-0 right-0', LABEL_OFFSET)}>
              <span
                className="absolute top-6 bottom-0 w-[1.5px] -translate-x-1/2 bg-(--gantt-today)"
                style={{ left: `${todayX}%` }}
              />
              <span
                className="absolute top-[21px] size-1.5 -translate-x-1/2 rounded-full bg-(--gantt-today)"
                style={{ left: `${todayX}%` }}
              />
            </div>
          ) : null}
        </div>
      )}
      {notes.length > 0 ? (
        <p className="mt-1.5 text-meta text-fg-tertiary">
          {more > 0 ? (
            <Link
              to="/timeline"
              className="rounded-sm transition-colors duration-fast hover:text-fg hover:duration-instant"
            >
              {notes[0]}
            </Link>
          ) : (
            notes[0]
          )}
          {notes.length > 1 ? ` · ${notes[1]}` : null}
        </p>
      ) : null}
    </OverviewSection>
  )
}

function TimelineRowItem({
  row,
  today,
  timeline,
}: {
  row: TimelineRow
  today: ISODate
  timeline: MiniTimelineModel
}) {
  const { project, span, placed, milestones } = row
  const descriptionId = `mini-timeline-${project.id}`
  const description = [
    span ? formatDateRange(span.start, span.end, today) || null : 'No dates',
    milestones.length > 0
      ? `${plural(milestones.length, 'milestone')}: ${milestones
          .map((m) => `${m.name} (${formatDate(m.date, 'short')})`)
          .join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join('. ')

  return (
    <li
      className={cn(
        'relative flex h-7 items-center rounded-md',
        'transition-colors duration-fast hover:bg-hover hover:duration-instant',
      )}
    >
      <Link
        to={`/projects/${project.id}/gantt`}
        aria-describedby={descriptionId}
        className={cn(
          'flex min-w-0 shrink-0 items-center gap-2 pr-3 pl-1 text-meta text-fg-secondary',
          LABEL_COLUMN,
          'after:absolute after:inset-0 after:rounded-md after:content-[""] focus-visible:outline-none',
          'focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus',
        )}
      >
        <ProjectDot color={project.color} />
        <span className="min-w-0 truncate">{project.name}</span>
      </Link>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
      <div aria-hidden className="relative h-full min-w-0 flex-1">
        {placed ? (
          <span
            data-span=""
            className={cn(
              'absolute top-1/2 h-2 -translate-y-1/2 bg-(--gantt-bar-fill-active)',
              placed.clippedStart ? 'rounded-l-none' : 'rounded-l-full',
              placed.clippedEnd ? 'rounded-r-none' : 'rounded-r-full',
            )}
            style={{ left: `${placed.left}%`, width: `max(${placed.width}%, 6px)` }}
          />
        ) : null}
        {milestones.map((milestone) => {
          const x = dayCenter(milestone.date, timeline.window)
          if (x === null) return null
          const past = milestone.date < today
          return (
            <span
              key={milestone.id}
              data-milestone=""
              className={cn(
                'absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1.5px]',
                past
                  ? 'border-[1.5px] border-(--gantt-milestone-past) bg-(--gantt-bg)'
                  : 'bg-(--gantt-milestone)',
              )}
              style={{ left: `${x}%` }}
            />
          )
        })}
      </div>
    </li>
  )
}
