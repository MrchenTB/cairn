import {
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { NavLink } from 'react-router'
import {
  ChartGantt,
  FolderKanban,
  LayoutDashboard,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
} from 'lucide-react'
import { LogoMark } from '@/components/brand/Logo'
import { ProjectDot } from '@/components/task/ProjectDot'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { useProjects, useToday, useWorkspaceData, useWorkspaceStatus } from '@/data/hooks'
import { bucketPopulation, dueBucket } from '@/domain/buckets'
import type { Project } from '@/domain/types'
import { cn } from '@/lib/utils'
import { SHORTCUTS, useCurrentProjectId } from '../shortcuts'
import { useSetSidebarCollapsed, useSidebarCollapsed } from '../uiPrefs'
import { useUIStore } from '../uiStore'
import { useRecentProjectIds } from '../viewPrefs'
import { sidebarIconClass, sidebarItemClass } from './sidebarStyles'
import { SyncIndicator } from './SyncIndicator'

const RECENT_LIMIT = 5

interface NavItemProps {
  to: string
  label: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  collapsed: boolean
  shortcut?: string
  /** Right-aligned count (expanded); kept for assistive tech when collapsed. */
  badge?: ReactNode
  /** Small dot on the icon in the collapsed rail. */
  badgeDot?: 'danger' | 'neutral' | null
  /** Collapsed-rail tooltip (default: the label). Spell out what a badge dot means here. */
  tooltip?: ReactNode
  end?: boolean
}

function NavItem({
  to,
  label,
  icon: Icon,
  collapsed,
  shortcut,
  badge,
  badgeDot,
  tooltip,
  end,
}: NavItemProps) {
  return (
    <Tooltip
      content={tooltip ?? label}
      shortcut={shortcut}
      side="right"
      delayDuration={300}
      disabled={!collapsed}
    >
      <NavLink to={to} end={end} className={cn(sidebarItemClass, collapsed ? 'w-9' : 'w-full')}>
        <span className="relative flex shrink-0">
          <Icon className={sidebarIconClass} strokeWidth={1.75} />
          {collapsed && badgeDot ? (
            <span
              aria-hidden
              className={cn(
                'absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-2 ring-(--bg-sidebar)',
                badgeDot === 'danger' ? 'bg-danger' : 'bg-fg-tertiary',
              )}
            />
          ) : null}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate transition-opacity duration-fast',
            collapsed && 'opacity-0',
          )}
        >
          {label}
        </span>
        {badge ? (
          <span className={cn('flex shrink-0', collapsed && 'sr-only')}>{badge}</span>
        ) : null}
      </NavLink>
    </Tooltip>
  )
}

/** Overdue + due-today counts for the My Tasks badge (shared bucket rules). */
function useMyTasksAttention() {
  const data = useWorkspaceData()
  const today = useToday()
  return useMemo(() => {
    let overdue = 0
    let dueToday = 0
    for (const task of bucketPopulation(data)) {
      const bucket = dueBucket(task, today)
      if (bucket === 'overdue') overdue++
      else if (bucket === 'today') dueToday++
    }
    return { overdue, dueToday, total: overdue + dueToday }
  }, [data, today])
}

/** "1 overdue · 2 due today" — what the My Tasks dot means, shown in the collapsed rail tooltip. */
function attentionSummary({ overdue, dueToday }: { overdue: number; dueToday: number }): string {
  return [overdue > 0 ? `${overdue} overdue` : null, dueToday > 0 ? `${dueToday} due today` : null]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Visible count + a spoken phrase. (aria-label on a plain span is not allowed by ARIA and is
 * dropped by some screen readers, so the phrase is real, visually hidden text.)
 */
function MyTasksBadge({ overdue, total }: { overdue: number; total: number }) {
  return (
    <span
      className={cn(
        'shrink-0 text-meta tabular-nums',
        // The stronger danger tone: plain --danger is 4.3:1 on the tinted active row (light theme).
        overdue > 0 ? 'text-danger-hover' : 'text-fg-tertiary',
      )}
    >
      <span aria-hidden>{total}</span>
      {/* Leading comma: read as a pause after "My Tasks". */}
      <span className="sr-only">
        {overdue > 0
          ? `, ${total} due today or overdue (${overdue} overdue)`
          : `, ${total} due today`}
      </span>
    </span>
  )
}

/**
 * Sidebar "Recent": visited projects (most recent first), topped up with other active projects
 * in their list order so the section never shrinks after the first visit. Max 5.
 */
function useRecentProjects(): Project[] {
  const recentIds = useRecentProjectIds()
  const projects = useProjects()
  return useMemo(() => {
    const byId = new Map(projects.map((project) => [project.id, project]))
    const recent: Project[] = []
    for (const id of recentIds) {
      const project = byId.get(id)
      if (project) recent.push(project)
    }
    const shown = new Set(recent.map((project) => project.id))
    const others = projects.filter((p) => p.status === 'active' && !shown.has(p.id))
    return [...recent, ...others].slice(0, RECENT_LIMIT)
  }, [projects, recentIds])
}

function RecentProjects({ items }: { items: Project[] }) {
  const { status } = useWorkspaceStatus()
  const openProjectDialog = useUIStore((s) => s.openProjectDialog)

  return (
    <section aria-labelledby="sidebar-recent" className="mt-4 flex min-h-0 flex-col">
      {/* pr-1 centres the 24px "+" under the 28px collapse button above it. */}
      <div className="flex h-6 shrink-0 items-center justify-between pr-1 pl-2.5">
        <h2 id="sidebar-recent" className="text-meta font-medium text-fg-tertiary">
          Recent
        </h2>
        <Tooltip content="New project" side="right">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New project"
            className="text-fg-tertiary"
            onClick={() => openProjectDialog({ mode: 'create' })}
          >
            <Plus strokeWidth={1.75} />
          </Button>
        </Tooltip>
      </div>
      {/* py-1 leaves room for the outset focus ring inside the scroll container. */}
      <div className="-mx-2 -mt-0.5 flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2 py-1">
        {status === 'error' ? (
          <p className="px-2.5 py-1 text-meta text-fg-tertiary">Couldn’t load projects</p>
        ) : status !== 'ready' ? (
          [0, 1, 2].map((index) => (
            <div key={index} className="flex h-7 items-center gap-2 px-2.5">
              <Skeleton className="size-2 rounded-full" />
              <Skeleton className={cn('h-2.5', index === 1 ? 'w-24' : 'w-32')} />
            </div>
          ))
        ) : items.length === 0 ? (
          <p className="px-2.5 py-1 text-meta text-fg-tertiary">No projects yet</p>
        ) : (
          items.map((project) => (
            <NavLink
              key={project.id}
              to={`/projects/${project.id}`}
              className={cn(sidebarItemClass, 'w-full font-normal')}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                <ProjectDot color={project.color} />
              </span>
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
            </NavLink>
          ))
        )}
      </div>
    </section>
  )
}

interface SidebarHeaderProps {
  collapsed: boolean
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void
  toggleRef: Ref<HTMLButtonElement>
}

function SidebarHeader({ collapsed, onToggle, toggleRef }: SidebarHeaderProps) {
  if (collapsed) {
    return (
      <div className="flex h-11 shrink-0 items-center">
        <Tooltip content="Expand sidebar" shortcut={SHORTCUTS.toggleSidebar} side="right">
          <button
            ref={toggleRef}
            type="button"
            aria-label="Expand sidebar"
            onClick={onToggle}
            className={cn(
              'group/logo grid h-7 w-9 place-items-center rounded-md text-fg',
              'transition-colors duration-fast hover:bg-hover hover:duration-instant',
            )}
          >
            <LogoMark
              size={18}
              className="col-start-1 row-start-1 group-hover/logo:opacity-0 group-focus-visible/logo:opacity-0"
            />
            <PanelLeftOpen
              className="col-start-1 row-start-1 size-4 text-fg-secondary opacity-0 group-hover/logo:opacity-100 group-focus-visible/logo:opacity-100"
              strokeWidth={1.75}
            />
          </button>
        </Tooltip>
      </div>
    )
  }
  return (
    <div className="flex h-11 shrink-0 items-center justify-between pr-0.5 pl-2">
      <span className="flex min-w-0 items-center gap-2.5 text-fg">
        <LogoMark size={20} />
        <span className="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em]">
          Cairn
        </span>
      </span>
      <Tooltip content="Collapse sidebar" shortcut={SHORTCUTS.toggleSidebar} side="bottom">
        <Button
          ref={toggleRef}
          variant="ghost"
          size="icon"
          aria-label="Collapse sidebar"
          onClick={onToggle}
        >
          <PanelLeftClose className="text-fg-tertiary" strokeWidth={1.75} />
        </Button>
      </Tooltip>
    </div>
  )
}

/**
 * App sidebar on the darker app layer: workspace row, main navigation, recent projects, then
 * sync state and Settings pinned at the bottom. Collapses to a 52px icon rail ([ or the button);
 * icons keep their x position while the width animates.
 */
export function Sidebar() {
  const collapsed = useSidebarCollapsed()
  const setCollapsed = useSetSidebarCollapsed()
  const attention = useMyTasksAttention()
  const recent = useRecentProjects()
  const currentProjectId = useCurrentProjectId()
  // The expand/collapse buttons are different elements: when the focused one is replaced,
  // move focus to its counterpart so keyboard users keep their place.
  const toggleRef = useRef<HTMLButtonElement>(null)
  const refocusToggle = useRef(false)

  useLayoutEffect(() => {
    if (!refocusToggle.current) return
    refocusToggle.current = false
    toggleRef.current?.focus({ preventScroll: true })
  }, [collapsed])

  const onToggle = (event: MouseEvent<HTMLButtonElement>) => {
    refocusToggle.current = document.activeElement === event.currentTarget
    setCollapsed(!collapsed)
  }

  // One "current" item: on a project page the Recent entry is it (when it is listed), so the
  // Projects item only matches /projects itself.
  const projectListed = !collapsed && recent.some((project) => project.id === currentProjectId)

  return (
    <aside
      aria-label="Sidebar"
      data-collapsed={collapsed}
      className={cn(
        'relative z-(--z-sidebar) flex h-full shrink-0 flex-col overflow-hidden bg-sidebar',
        'transition-[width] duration-slow ease-move motion-reduce:transition-none',
        collapsed ? 'w-(--sidebar-width-collapsed)' : 'w-(--sidebar-width)',
      )}
    >
      <div className="flex min-h-0 w-(--sidebar-width) flex-1 flex-col px-2 pt-2 pb-2">
        <SidebarHeader collapsed={collapsed} onToggle={onToggle} toggleRef={toggleRef} />
        <nav aria-label="Main" className="mt-1 flex flex-col gap-0.5">
          <NavItem
            to="/overview"
            label="Overview"
            icon={LayoutDashboard}
            collapsed={collapsed}
            shortcut={SHORTCUTS.goOverview}
          />
          <NavItem
            to="/my-tasks"
            label="My Tasks"
            icon={ListTodo}
            collapsed={collapsed}
            shortcut={SHORTCUTS.goMyTasks}
            badge={
              attention.total > 0 ? (
                <MyTasksBadge overdue={attention.overdue} total={attention.total} />
              ) : null
            }
            badgeDot={attention.overdue > 0 ? 'danger' : attention.total > 0 ? 'neutral' : null}
            tooltip={
              attention.total > 0 ? (
                <span>
                  My Tasks
                  <span className="text-fg-inverse/70"> · {attentionSummary(attention)}</span>
                </span>
              ) : undefined
            }
          />
          <NavItem
            to="/projects"
            label="Projects"
            icon={FolderKanban}
            collapsed={collapsed}
            shortcut={SHORTCUTS.goProjects}
            end={projectListed}
          />
          <NavItem
            to="/timeline"
            label="Timeline"
            icon={ChartGantt}
            collapsed={collapsed}
            shortcut={SHORTCUTS.goTimeline}
          />
        </nav>
        {collapsed ? <div className="flex-1" /> : <RecentProjects items={recent} />}
        <div className={cn('flex flex-col gap-0.5', !collapsed && 'mt-auto pt-3')}>
          <SyncIndicator collapsed={collapsed} />
          <NavItem to="/settings" label="Settings" icon={Settings} collapsed={collapsed} />
        </div>
      </div>
    </aside>
  )
}
