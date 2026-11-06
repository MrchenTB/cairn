/**
 * The Timeline's own rows: a project (chevron, name → its Gantt, progress on the left; on the time
 * axis its range in the project colour at low emphasis, progress as a deeper fill, milestones as
 * diamonds, a small label) and the "Unscheduled" header. Task and milestone rows under an expanded
 * project are the Gantt's own GanttRowView.
 */
import {
  memo,
  useId,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { Link } from 'react-router'
import { CalendarOff, ChevronRight, CircleCheck } from 'lucide-react'
import { ProjectDot } from '@/components/task/ProjectDot'
import { PROJECT_COLOR_VAR } from '@/components/task/labels'
import { ProjectStatusBadge } from '@/components/task/ProjectStatusBadge'
import { hoverFade, insetFocus } from '@/components/ui/styles'
import { formatDate } from '@/domain/dates'
import type { ISODate } from '@/domain/types'
import { MilestoneDiamond } from '@/features/gantt/components/bars'
import { cellBase, cellSurface } from '@/features/gantt/components/GanttRow'
import { measureLabelWidth } from '@/features/gantt/components/measure'
import { BAR_HEIGHT, DUE_COLUMN_WIDTH, ROW_HEIGHT } from '@/features/gantt/model/constants'
import { dayCenterX, rangeRect, type TimelineGeometry } from '@/features/gantt/model/geometry'
import type { ScrollPosition } from '@/features/gantt/model/scrollPosition'
import { cn } from '@/lib/utils'
import {
  FULL_LABEL,
  LABEL_INSET,
  NO_LABEL,
  insideLabelRoom,
  outsideLabelLeft,
} from './model/barLabel'
import {
  PROJECT_ROW_HEIGHT,
  UNSCHEDULED_SECTION_KEY,
  projectRowSummary,
  type ProjectRow,
} from './model/rows'

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export interface ProjectRowViewProps {
  row: ProjectRow
  index: number
  top: number
  geometry: TimelineGeometry
  paneWidth: number
  timelineWidth: number
  /** The chart's scroll position: a bar's name keeps clear of the diamonds as it follows it. */
  scroll: ScrollPosition
  today: ISODate
  todayDay: number
  nextMilestoneIds: ReadonlySet<string>
  describedBy: string
  onToggle: (projectId: string) => void
  onMilestoneKeyDown: (event: ReactKeyboardEvent<HTMLElement>, milestoneId: string) => void
}

export const ProjectRowView = memo(function ProjectRowView({
  row,
  index,
  top,
  geometry,
  paneWidth,
  timelineWidth,
  scroll,
  today,
  todayDay,
  nextMilestoneIds,
  describedBy,
  onToggle,
  onMilestoneKeyDown,
}: ProjectRowViewProps) {
  const { project } = row
  const summaryId = useId()
  const summary = projectRowSummary(row, today)
  const completed = project.status === 'completed'
  return (
    <div
      data-row-index={index}
      data-row-key={row.key}
      className="group/row absolute left-0 flex"
      style={{ top, height: PROJECT_ROW_HEIGHT, width: paneWidth + timelineWidth }}
    >
      <div className={cn(cellBase, cellSurface, 'gap-1.5 pr-3 pl-2')} style={{ width: paneWidth }}>
        {row.childCount > 0 && row.range ? (
          <button
            type="button"
            aria-expanded={row.expanded}
            aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${project.name}, ${plural(row.childCount, 'scheduled item')}`}
            onClick={() => onToggle(project.id)}
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-hover',
              insetFocus,
            )}
          >
            <ChevronRight
              className={cn(
                'size-3.5 text-fg-tertiary motion-safe:transition-transform motion-safe:duration-fast',
                row.expanded && 'rotate-90',
              )}
              aria-hidden
            />
          </button>
        ) : (
          <span className="w-6 shrink-0" aria-hidden />
        )}
        <ProjectDot color={project.color} />
        <Link
          to={`/projects/${encodeURIComponent(project.id)}/gantt`}
          title={project.name}
          aria-describedby={summaryId}
          className={cn(
            'ml-0.5 min-w-0 flex-1 truncate rounded-sm text-ui font-medium',
            'transition-colors duration-fast hover:text-accent-text hover:duration-instant',
            completed ? 'text-fg-secondary' : 'text-fg',
            insetFocus,
          )}
        >
          {project.name}
        </Link>
        <span id={summaryId} className="sr-only">
          {summary}
        </span>
        <span
          aria-hidden
          className="flex shrink-0 justify-end text-meta text-fg-tertiary tabular-nums"
          style={{ width: DUE_COLUMN_WIDTH }}
        >
          {completed ? (
            <ProjectStatusBadge status={project.status} size="sm" />
          ) : row.progress.percent === null ? (
            'No tasks'
          ) : (
            `${row.progress.percent}%`
          )}
        </span>
      </div>
      <div
        className="relative flex h-full shrink-0 items-center group-hover/row:bg-(--gantt-row-hover)"
        style={{ width: timelineWidth }}
      >
        {row.range ? (
          <ProjectBar
            row={row}
            geometry={geometry}
            paneWidth={paneWidth}
            scroll={scroll}
            summary={summary}
          />
        ) : null}
        {/* The Gantt's diamonds centre themselves in a 32px row. */}
        <div
          className="absolute inset-x-0"
          style={{ top: (PROJECT_ROW_HEIGHT - ROW_HEIGHT) / 2, height: ROW_HEIGHT }}
        >
          {row.milestones.map(({ milestone, day }) => (
            // Its own parent, so the name chip only answers to its own diamond (CSS peer).
            <div key={milestone.id} className="contents">
              <MilestoneDiamond
                milestoneId={milestone.id}
                name={`${milestone.name} · ${formatDate(milestone.date, 'short')}`}
                centerX={dayCenterX(day, geometry)}
                rowIndex={index}
                ariaLabel={`Milestone ${milestone.name}, ${formatDate(milestone.date, 'medium')}, ${project.name}`}
                describedBy={describedBy}
                past={day < todayDay}
                upcoming={nextMilestoneIds.has(milestone.id)}
                dragging={false}
                readOnly
                nameOnHover
                onKeyDown={(event) => onMilestoneKeyDown(event, milestone.id)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
})

/** The name inside its bar. It follows the scroll, so it is re-fitted to the diamonds as it moves. */
function InsideLabel({
  name,
  glyph,
  completed,
  paneWidth,
  scroll,
  barLeft,
  barWidth,
  labelWidth,
  diamondXs,
}: {
  name: string
  glyph: ReactNode
  completed: boolean
  paneWidth: number
  scroll: ScrollPosition
  barLeft: number
  barWidth: number
  labelWidth: number
  diamondXs: readonly number[]
}) {
  // A number, so React only re-renders when the room itself changes (not on every scroll tick).
  const room = useSyncExternalStore(
    scroll.subscribe,
    () => insideLabelRoom({ barLeft, barWidth, labelWidth, diamondXs, scrollLeft: scroll.get() }),
    () => insideLabelRoom({ barLeft, barWidth, labelWidth, diamondXs, scrollLeft: 0 }),
  )
  if (room === NO_LABEL) return null
  return (
    <span
      aria-hidden
      data-bar-label=""
      className={cn(
        'pointer-events-none sticky flex items-center gap-1 whitespace-nowrap',
        completed ? 'text-fg-secondary' : 'font-medium text-fg',
      )}
      style={{
        left: paneWidth + LABEL_INSET,
        marginLeft: LABEL_INSET,
        maxWidth: room === FULL_LABEL ? undefined : room,
      }}
    >
      {glyph}
      <span className="min-w-0 truncate">{name}</span>
    </span>
  )
}

function ProjectBar({
  row,
  geometry,
  paneWidth,
  scroll,
  summary,
}: {
  row: ProjectRow
  geometry: TimelineGeometry
  paneWidth: number
  scroll: ScrollPosition
  summary: string
}) {
  const { project, range, progress } = row
  if (!range) return null
  const rect = rangeRect(range.start, range.end, geometry)
  const completed = project.status === 'completed'
  const expandable = row.childCount > 0
  const labelWidth = measureLabelWidth(project.name) + (completed ? 16 : 0)
  const labelInside = rect.width >= labelWidth + 2 * LABEL_INSET
  // Ascending (milestones are in date order): the name keeps clear of these as it moves.
  const diamondXs = row.milestones.map(({ day }) => dayCenterX(day, geometry))
  const glyph = completed ? (
    <CircleCheck className="size-3 shrink-0 text-fg-tertiary" aria-hidden />
  ) : null
  const style = {
    left: rect.left,
    width: rect.width,
    top: (PROJECT_ROW_HEIGHT - BAR_HEIGHT) / 2,
    height: BAR_HEIGHT,
    '--project-bar': PROJECT_COLOR_VAR[project.color] ?? PROJECT_COLOR_VAR.gray,
  } as CSSProperties
  return (
    <>
      <div
        data-project-bar={project.id}
        title={`${project.name}: ${summary}`}
        className={cn(
          'absolute z-[2] flex items-center rounded-sm border text-meta select-none',
          'border-[color-mix(in_srgb,var(--project-bar)_55%,transparent)]',
          completed
            ? 'bg-[color-mix(in_srgb,var(--project-bar)_7%,transparent)]'
            : 'bg-[color-mix(in_srgb,var(--project-bar)_14%,transparent)]',
          expandable && [
            'cursor-pointer hover:border-[color-mix(in_srgb,var(--project-bar)_90%,transparent)]',
            hoverFade,
          ],
        )}
        style={style}
      >
        {progress.ratio ? (
          <span
            data-progress-fill=""
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-y-0 left-0 rounded-l-[3px]',
              progress.ratio >= 1 && 'rounded-r-[3px]',
              completed
                ? 'bg-[color-mix(in_srgb,var(--project-bar)_14%,transparent)]'
                : 'bg-[color-mix(in_srgb,var(--project-bar)_28%,transparent)]',
            )}
            style={{ width: `${progress.ratio * 100}%` }}
          />
        ) : null}
        {labelInside ? (
          // Follows the scroll inside the bar, so a long bar keeps its name on screen.
          <InsideLabel
            name={project.name}
            glyph={glyph}
            completed={completed}
            paneWidth={paneWidth}
            scroll={scroll}
            barLeft={rect.left}
            barWidth={rect.width}
            labelWidth={labelWidth}
            diamondXs={diamondXs}
          />
        ) : null}
      </div>
      {labelInside ? null : (
        <span
          aria-hidden
          data-bar-label=""
          className="pointer-events-none absolute z-[2] flex items-center gap-1 text-meta whitespace-nowrap text-fg-secondary"
          style={{
            // After the bar, and past any diamond that sits there (a one-day project is its diamond).
            left: outsideLabelLeft(rect.left, rect.width, labelWidth, diamondXs),
            top: (PROJECT_ROW_HEIGHT - BAR_HEIGHT) / 2,
            height: BAR_HEIGHT,
          }}
        >
          {glyph}
          {project.name}
        </span>
      )}
    </>
  )
}

/** Header of the projects without any dates, at the bottom of the chart. */
export function UnscheduledSection({
  index,
  top,
  count,
  paneWidth,
  timelineWidth,
}: {
  index: number
  top: number
  count: number
  paneWidth: number
  timelineWidth: number
}) {
  return (
    <div
      data-row-index={index}
      data-row-key={UNSCHEDULED_SECTION_KEY}
      className="absolute left-0 flex"
      style={{ top, height: ROW_HEIGHT, width: paneWidth + timelineWidth }}
    >
      <div className={cn(cellBase, 'gap-1.5 bg-muted pr-3 pl-3')} style={{ width: paneWidth }}>
        <CalendarOff className="size-3.5 shrink-0 text-fg-tertiary" aria-hidden />
        <span className="truncate text-meta font-semibold text-fg-secondary">Unscheduled</span>
        <span className="text-meta text-fg-tertiary tabular-nums">{count}</span>
      </div>
      <div
        className="relative flex h-full shrink-0 items-center bg-muted"
        style={{ width: timelineWidth }}
      >
        {/* Above the today line (z-[1]) on the header's own background. */}
        <span
          className="pointer-events-none sticky z-[2] rounded-sm bg-muted px-1 text-meta whitespace-nowrap text-fg-tertiary"
          style={{ left: paneWidth + LABEL_INSET }}
        >
          No dates on these projects, their tasks or milestones yet
        </span>
      </div>
    </div>
  )
}
