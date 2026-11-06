import { useCallback, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { ErrorState } from '@/components/layout/ErrorState'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  useActions,
  usePhases,
  useProject,
  useProjectTasks,
  useToday,
  useWorkspaceStatus,
} from '@/data/hooks'
import { buildProjectOutline } from '@/domain/hierarchy'
import { ViewBarActions } from '@/features/projects/viewBar'
import { Board } from './Board'
import {
  ALL_PHASES,
  BOARD_COLUMNS,
  buildBoard,
  filteredPhase,
  NO_PHASE,
  PHASE_PARAM,
  resolvePhaseFilter,
} from './boardModel'
import { PhaseFilter } from './PhaseFilter'

/** Quiet column skeletons while the workspace loads (no spinner, no shimmer). */
function BoardSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="grid min-h-0 flex-1 grid-cols-[repeat(3,minmax(280px,1fr))] gap-3 overflow-hidden px-6 pt-2 pb-4 motion-safe:animate-fade-in-delayed"
    >
      <span className="sr-only">Loading board…</span>
      {BOARD_COLUMNS.map((status, column) => (
        <div key={status} className="flex flex-col gap-2 rounded-lg bg-muted p-2">
          <div className="flex h-7 items-center gap-2 px-1">
            <Skeleton className="size-4 rounded-[4px]" />
            <Skeleton className="h-3 w-20" />
          </div>
          {Array.from({ length: 3 - column }, (_, index) => (
            <Skeleton key={index} className="h-16 rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Board view (/projects/:projectId/board): three fixed columns of the project's top-level tasks
 * with drag and drop, inline "+ Add task" per column and an optional phase filter (`?phase=`,
 * shown in the view bar when the project has phases). Reads through the data hooks and writes
 * through store actions only, so List / Gantt show every change immediately.
 */
export function BoardView() {
  const { projectId } = useParams()
  const project = useProject(projectId)
  const phases = usePhases(projectId)
  const tasks = useProjectTasks(projectId)
  const today = useToday()
  const actions = useActions()
  const { status, loadError } = useWorkspaceStatus()
  const [searchParams, setSearchParams] = useSearchParams()

  const filter = resolvePhaseFilter(searchParams.get(PHASE_PARAM), phases)
  const outline = useMemo(
    () => (project ? buildProjectOutline(project, phases, tasks, []) : null),
    [project, phases, tasks],
  )
  const model = useMemo(() => (outline ? buildBoard(outline, filter) : null), [outline, filter])

  const setFilter = useCallback(
    (next: string) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current)
          if (next === ALL_PHASES) params.delete(PHASE_PARAM)
          else params.set(PHASE_PARAM, next)
          return params
        },
        { replace: true, preventScrollReset: true },
      )
    },
    [setSearchParams],
  )

  if (status === 'error') {
    return (
      <ErrorState
        title="Couldn’t load this board"
        message={loadError?.message}
        onRetry={() => void actions.load()}
      />
    )
  }
  if (status !== 'ready') return <BoardSkeleton />
  // Unknown project: the project layout shows "Project not found".
  if (!project || !model) return null

  const phase = filteredPhase(filter, phases)
  const visible = BOARD_COLUMNS.reduce((sum, column) => sum + model.columns[column].length, 0)
  const filteredEmpty = filter !== ALL_PHASES && visible === 0 && model.totalTasks > 0

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {phases.length > 0 ? (
        <ViewBarActions>
          <PhaseFilter value={filter} phases={phases} onChange={setFilter} />
        </ViewBarActions>
      ) : null}
      {filteredEmpty ? (
        // Overlaid (not in flow) so the columns do not jump when a filter empties the board.
        <div className="pointer-events-none absolute inset-x-0 top-[40%] z-10 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-default bg-main px-3 py-1.5 text-ui text-fg-secondary">
            <p role="status">
              {filter === NO_PHASE
                ? 'Every task in this project has a phase.'
                : `No tasks in “${phase?.name ?? 'this phase'}” yet.`}
            </p>
            <Button variant="link" size="xs" onClick={() => setFilter(ALL_PHASES)}>
              Show all phases
            </Button>
          </div>
        </div>
      ) : null}
      <Board
        key={project.id}
        projectId={project.id}
        model={model}
        phaseFilter={filter}
        showPhase={phases.length > 0 && phase === null && filter !== NO_PHASE}
        today={today}
      />
    </div>
  )
}
