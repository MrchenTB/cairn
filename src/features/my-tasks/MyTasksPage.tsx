/**
 * /my-tasks/:tab — every open task across projects, in the shared bucket definitions
 * (src/domain/buckets.ts): Today, Upcoming (next 7 days), Overdue and All (grouped by due date,
 * completed tasks on request via `?completed=1`). Counts come from the same `myTasks()` result
 * as the rows, so they always agree with each other and with the Overview.
 */
import { useMemo, type ComponentType, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { CalendarCheck, CalendarRange, CircleCheck, Info, ListTodo, Plus } from 'lucide-react'
import { useViewShortcut } from '@/app/shortcuts'
import { useUIStore } from '@/app/uiStore'
import { ErrorState } from '@/components/layout/ErrorState'
import { LoadingState } from '@/components/layout/LoadingState'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { NavTab, NavTabs } from '@/components/ui/tabs'
import { Tooltip } from '@/components/ui/tooltip'
import {
  useActions,
  usePreferences,
  useToday,
  useWorkspaceData,
  useWorkspaceStatus,
} from '@/data/hooks'
import { myTasks } from '@/domain/buckets'
import { formatDate } from '@/domain/dates'
import { cn } from '@/lib/utils'
import {
  GROUP_LABELS,
  MY_TASKS_TABS,
  SHOW_COMPLETED_PARAM,
  TAB_DEFINITIONS,
  TAB_LABELS,
  groupAllTasks,
  myTasksCounts,
  parseMyTasksTab,
  type MyTasksCounts,
  type MyTasksTab,
} from './myTasksModel'
import { TaskRowList, type TaskRowSection } from './TaskRowList'

function taskCount(count: number, noun = 'task'): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`
}

export function MyTasksPage() {
  const { status, loadError } = useWorkspaceStatus()
  const actions = useActions()
  if (status === 'error') {
    return (
      <ErrorState
        titleAs="h1"
        title="Couldn’t load your tasks"
        message={loadError?.message}
        onRetry={() => void actions.load()}
      />
    )
  }
  if (status !== 'ready') return <LoadingState label="Loading your tasks…" />
  return <MyTasks />
}

function MyTasks() {
  const params = useParams()
  const tab = parseMyTasksTab(params.tab)
  const [searchParams, setSearchParams] = useSearchParams()
  const showCompleted = tab === 'all' && searchParams.get(SHOW_COMPLETED_PARAM) === '1'
  const data = useWorkspaceData()
  const today = useToday()
  const buckets = useMemo(() => myTasks(data, today), [data, today])
  const counts = useMemo(() => myTasksCounts(buckets), [buckets])
  const openNewTask = useUIStore((s) => s.openNewTask)

  // On Today a new task is due today, so it lands in the list the user is looking at.
  const newTask = () => openNewTask(tab === 'today' ? { dueDate: today } : {})
  useViewShortcut('c', newTask, { description: 'New task due today', enabled: tab === 'today' })

  const setShowCompleted = (show: boolean) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (show) next.set(SHOW_COMPLETED_PARAM, '1')
        else next.delete(SHOW_COMPLETED_PARAM)
        return next
      },
      { replace: true },
    )

  const sections = useMemo<TaskRowSection[]>(() => {
    if (tab !== 'all') return [{ key: tab, tasks: buckets[tab] }]
    return groupAllTasks(buckets.all, today, showCompleted).map((group) => ({
      key: group.bucket,
      title: GROUP_LABELS[group.bucket],
      tasks: group.tasks,
    }))
  }, [tab, buckets, today, showCompleted])
  const empty = sections.every((section) => section.tasks.length === 0)

  return (
    <PageContainer width="full">
      <PageHeader
        title="My Tasks"
        actions={
          <Tooltip content={tab === 'today' ? 'New task due today' : 'New task'} shortcut="c">
            <Button variant="secondary" size="sm" onClick={newTask} aria-keyshortcuts="C">
              <Plus strokeWidth={2} />
              New task
            </Button>
          </Tooltip>
        }
        tabs={<MyTasksTabs counts={counts} />}
        viewActions={
          <>
            {tab === 'all' ? (
              <div className="flex items-center gap-2 pr-1">
                <Switch
                  id="my-tasks-show-completed"
                  checked={showCompleted}
                  onCheckedChange={setShowCompleted}
                />
                <Label htmlFor="my-tasks-show-completed" className="text-ui">
                  Show completed
                  <span className="font-normal text-fg-tertiary tabular-nums">{counts.done}</span>
                </Label>
              </div>
            ) : null}
            <DefinitionsPopover today={today} />
          </>
        }
      />
      {empty ? (
        <MyTasksEmpty
          tab={tab}
          counts={counts}
          onNewTask={newTask}
          onShowCompleted={() => setShowCompleted(true)}
        />
      ) : (
        <TaskRowList
          sections={sections}
          label={tab === 'all' ? 'All tasks' : `${TAB_LABELS[tab]} tasks`}
          showsDone={showCompleted}
          rowClassName="pr-6 pl-5"
          headingClassName="sticky top-(--viewbar-height) z-(--z-sticky) px-6"
          className="pt-1 pb-10"
        />
      )}
    </PageContainer>
  )
}

function MyTasksTabs({ counts }: { counts: MyTasksCounts }) {
  return (
    <NavTabs aria-label="My Tasks">
      {MY_TASKS_TABS.map((tab) => {
        const count = counts[tab]
        const spoken = tab === 'all' ? taskCount(count, 'open task') : taskCount(count)
        return (
          <Tooltip key={tab} content={TAB_DEFINITIONS[tab]} side="bottom">
            <NavTab to={`/my-tasks/${tab}`}>
              {TAB_LABELS[tab]}
              <span
                aria-hidden
                className={cn(
                  'text-meta tabular-nums',
                  tab === 'overdue' && count > 0 ? 'text-danger' : 'text-fg-tertiary',
                )}
              >
                {count}
              </span>
              <span className="sr-only">, {spoken}</span>
            </NavTab>
          </Tooltip>
        )
      })}
    </NavTabs>
  )
}

/** What each tab means (the same bucket rules as the Overview and the sidebar badge). */
function DefinitionsPopover({ today }: { today: string }) {
  const { timezone } = usePreferences()
  return (
    <Popover>
      <Tooltip content="How tasks are grouped" side="bottom" align="end">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="How tasks are grouped">
            <Info strokeWidth={1.75} />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-4" aria-labelledby="my-tasks-definitions">
        <h2 id="my-tasks-definitions" className="text-ui font-semibold text-fg">
          How tasks are grouped
        </h2>
        <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 text-ui">
          {MY_TASKS_TABS.map((tab) => (
            <div key={tab} className="contents">
              <dt className="font-medium text-fg">{TAB_LABELS[tab]}</dt>
              <dd className="text-fg-secondary">{TAB_DEFINITIONS[tab]}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-meta text-fg-tertiary">
          Subtasks count like any other task. Archived projects are left out. Today is{' '}
          {formatDate(today, 'long')} ({timezone}).
        </p>
      </PopoverContent>
    </Popover>
  )
}

interface EmptyCopy {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  title: string
  description: string
  action?: ReactNode
  secondaryAction?: ReactNode
}

function MyTasksEmpty({
  tab,
  counts,
  onNewTask,
  onShowCompleted,
}: {
  tab: MyTasksTab
  counts: MyTasksCounts
  onNewTask: () => void
  onShowCompleted: () => void
}) {
  const tabLink = (to: MyTasksTab, text: string) => (
    <Button variant="link" size="sm" asChild>
      <Link to={`/my-tasks/${to}`}>{text}</Link>
    </Button>
  )
  const nothingYet = counts.all === 0 && counts.done === 0
  const copy: EmptyCopy = (() => {
    switch (tab) {
      case 'today':
        return {
          icon: CalendarCheck,
          title: 'Nothing due today',
          description: 'Tasks due today that aren’t done show up here.',
          secondaryAction:
            counts.overdue > 0
              ? tabLink('overdue', `View ${taskCount(counts.overdue, 'overdue task')}`)
              : counts.upcoming > 0
                ? tabLink('upcoming', `View ${taskCount(counts.upcoming, 'upcoming task')}`)
                : undefined,
        }
      case 'upcoming':
        return {
          icon: CalendarRange,
          title: 'Nothing due in the next 7 days',
          description: 'Tasks due after today and within a week show up here.',
          secondaryAction:
            counts.all > 0 ? tabLink('all', `View all ${taskCount(counts.all, 'open task')}`) : undefined,
        }
      case 'overdue':
        return {
          icon: CircleCheck,
          title: 'No overdue tasks',
          description: 'Everything with a past due date is done.',
        }
      case 'all':
        return nothingYet
          ? {
              icon: ListTodo,
              title: 'No tasks yet',
              description: 'Tasks from all your projects show up here.',
              action: (
                <Button variant="secondary" size="md" onClick={onNewTask}>
                  <Plus strokeWidth={2} />
                  New task
                </Button>
              ),
            }
          : {
              icon: CircleCheck,
              title: 'No open tasks',
              description: 'Every task is done.',
              action: (
                <Button variant="secondary" size="md" onClick={onShowCompleted}>
                  Show {taskCount(counts.done, 'completed task')}
                </Button>
              ),
            }
    }
  })()
  return (
    <EmptyState
      icon={copy.icon}
      title={copy.title}
      description={copy.description}
      action={copy.action}
      secondaryAction={copy.secondaryAction}
    />
  )
}
