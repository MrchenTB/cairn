/**
 * Global search overlay, mounted once by the app shell. Open state is `useUIStore().searchOpen`
 * (⌘/Ctrl+K and the top-bar button toggle it). Results come from `searchWorkspace` over the
 * loaded workspace — the same rules as everywhere else — so cmdk's own filtering is switched off
 * and this file only presents them.
 *
 * - Empty query → quick actions (New task / project, Toggle theme, Go to …) and recent projects.
 * - Project → its remembered view · task → that project's remembered view with `?task=<id>`
 *   (opens the Task Modal) · milestone → the project's Gantt and the milestone dialog.
 * - ↑/↓ move, Enter opens, Esc closes; focus goes to the input on open and back on close (to the
 *   page itself after a result navigated somewhere else).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, type To } from 'react-router'
import {
  ChartGantt,
  FolderKanban,
  FolderPlus,
  LayoutDashboard,
  ListTodo,
  Moon,
  Plus,
  Settings,
  Sun,
} from 'lucide-react'
import { SHORTCUTS, useCurrentProjectId } from '@/app/shortcuts'
import { useSystemPrefersDark } from '@/app/theme'
import { useSetThemePreference, useThemePreference } from '@/app/uiPrefs'
import { useUIStore } from '@/app/uiStore'
import { useRecentProjectIds } from '@/app/viewPrefs'
import {
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandList,
} from '@/components/ui/command'
import { Kbd, Shortcut } from '@/components/ui/kbd'
import { useProjects, useWorkspaceData } from '@/data/hooks'
import { searchWorkspace, type SearchResult } from '@/domain/search'
import type { Project } from '@/domain/types'
import {
  ignoreEscapeWhileComposing,
  returnFocusAfterClose,
} from '@/features/task-modal/dialogGuards'
import { groupResults, projectPath, resultLocation } from './results'
import { ActionRow, MilestoneRow, ProjectRow, RecentProjectRow, TaskRow } from './SearchRows'

const RECENT_LIMIT = 5
/** Matches listed at most; one more is requested to know whether the list was cut. */
const RESULT_LIMIT = 50

export function SearchOverlay() {
  const open = useUIStore((s) => s.searchOpen)
  const setOpen = useUIStore((s) => s.setSearchOpen)
  // True once a result navigated to another page: focus then goes to that page, not back to
  // whatever opened the overlay.
  const navigated = useRef(false)
  const markNavigated = useCallback(() => {
    navigated.current = true
  }, [])
  useEffect(() => {
    if (open) navigated.current = false
  }, [open])
  // Every opening gets a fresh panel (empty query, input focused). Without it, opening again while
  // the previous panel is still fading out (a result was just picked, then ⌘K) re-shows that very
  // panel: old query, and the focus wherever the click left it instead of in the input.
  const [openings, setOpenings] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setOpenings(openings + 1)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search"
      description="Search projects, tasks and milestones, or pick a quick action."
      commandProps={{
        label: 'Search projects, tasks and milestones',
        shouldFilter: false,
        loop: true,
        // Ctrl+K is "search" here, not cmdk's "previous item".
        vimBindings: false,
      }}
      contentProps={{
        // The Esc that cancels a CJK input-method composition must not close the overlay.
        onEscapeKeyDown: ignoreEscapeWhileComposing,
        onCloseAutoFocus: (event) => {
          if (!navigated.current) return // default: back to where the overlay was opened from
          navigated.current = false
          event.preventDefault()
          returnFocusAfterClose(null)
        },
      }}
    >
      <SearchPanel key={openings} onNavigate={markNavigated} />
    </CommandDialog>
  )
}

/** One per opening (see `openings`), so every opening starts with an empty query. */
function SearchPanel({ onNavigate }: { onNavigate: () => void }) {
  const navigate = useNavigate()
  const data = useWorkspaceData()
  const [query, setQuery] = useState('')
  const hasQuery = query.trim() !== ''
  const listRef = useRef<HTMLDivElement>(null)
  // cmdk moves the selection to the first row when the query changes, but first scrolls the OLD
  // selection into view and the list keeps that position: after scrolling down, refining the query
  // would leave the selected row out of sight. Scroll back to the top once cmdk is done (same
  // frame, so nothing flashes).
  const shownQuery = useRef(query)
  useEffect(() => {
    if (shownQuery.current === query) return
    shownQuery.current = query
    const frame = requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = 0
    })
    return () => cancelAnimationFrame(frame)
  }, [query])

  const found = useMemo(
    () => searchWorkspace(data, query, { limit: RESULT_LIMIT + 1 }),
    [data, query],
  )
  const cut = found.length > RESULT_LIMIT
  const results = useMemo(() => found.slice(0, RESULT_LIMIT), [found])
  const groups = useMemo(() => groupResults(results), [results])

  const close = useCallback(() => useUIStore.getState().setSearchOpen(false), [])
  const goTo = useCallback(
    (to: To) => {
      onNavigate()
      close()
      navigate(to)
    },
    [close, navigate, onNavigate],
  )

  const openResult = useCallback(
    (result: SearchResult) => {
      goTo(resultLocation(result))
      // The milestone dialog lives in the shell, so it can open right away over the Gantt.
      if (result.kind === 'milestone') {
        useUIStore
          .getState()
          .openMilestoneDialog({ mode: 'edit', milestoneId: result.milestone.id })
      }
    },
    [goTo],
  )
  const openProject = useCallback((project: Project) => goTo(projectPath(project.id)), [goTo])

  const announcement = !hasQuery
    ? ''
    : results.length === 0
      ? `No results for "${query.trim()}"`
      : cut
        ? `Showing the first ${RESULT_LIMIT} results`
        : `${results.length} ${results.length === 1 ? 'result' : 'results'}`

  return (
    <>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search projects, tasks and milestones…"
        autoComplete="off"
        spellCheck={false}
        autoFocus
      />
      <CommandList ref={listRef}>
        {hasQuery ? (
          <>
            <CommandEmpty>
              <span className="block font-medium text-fg">No results for "{query.trim()}"</span>
              <span className="mt-1 block text-meta text-fg-tertiary">
                Check the spelling or try fewer words. Archived projects are included.
              </span>
            </CommandEmpty>
            {groups.projects.length > 0 ? (
              <CommandGroup heading="Projects">
                {groups.projects.map((hit) => (
                  <ProjectRow key={hit.id} hit={hit} query={query} onOpen={openResult} />
                ))}
              </CommandGroup>
            ) : null}
            {groups.tasks.length > 0 ? (
              <CommandGroup heading="Tasks">
                {groups.tasks.map((hit) => (
                  <TaskRow key={hit.id} hit={hit} query={query} onOpen={openResult} />
                ))}
              </CommandGroup>
            ) : null}
            {groups.milestones.length > 0 ? (
              <CommandGroup heading="Milestones">
                {groups.milestones.map((hit) => (
                  <MilestoneRow key={hit.id} hit={hit} query={query} onOpen={openResult} />
                ))}
              </CommandGroup>
            ) : null}
          </>
        ) : (
          <QuickActions goTo={goTo} openProject={openProject} />
        )}
      </CommandList>
      <CommandFooter aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          Navigate
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          Open
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>Esc</Kbd>
          Close
        </span>
        {/* Always in view, unlike the end of a long list. The live region below announces it. */}
        {cut ? (
          <span className="ml-auto min-w-0 truncate">
            Showing the first {RESULT_LIMIT} matches · type more to narrow them
          </span>
        ) : null}
      </CommandFooter>
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </>
  )
}

/** What the list shows before anything is typed. */
function QuickActions({
  goTo,
  openProject,
}: {
  goTo: (to: To) => void
  openProject: (project: Project) => void
}) {
  const projectId = useCurrentProjectId()
  const projects = useProjects()
  const recentIds = useRecentProjectIds()
  const themePreference = useThemePreference()
  const systemDark = useSystemPrefersDark()
  const setTheme = useSetThemePreference()
  const darkNow = themePreference === 'system' ? systemDark : themePreference === 'dark'

  const recent = useMemo(() => {
    const byId = new Map(projects.map((project) => [project.id, project]))
    return recentIds
      .map((id) => byId.get(id))
      .filter((project): project is Project => project !== undefined)
      .slice(0, RECENT_LIMIT)
  }, [projects, recentIds])

  const close = () => useUIStore.getState().setSearchOpen(false)

  return (
    <>
      <CommandGroup heading="Quick actions">
        <ActionRow
          value="action:new-task"
          icon={Plus}
          label="New task"
          shortcut={<Shortcut keys={SHORTCUTS.newTask} />}
          // Opening the dialog also closes the overlay.
          onSelect={() => useUIStore.getState().openNewTask(projectId ? { projectId } : {})}
        />
        <ActionRow
          value="action:new-project"
          icon={FolderPlus}
          label="New project"
          onSelect={() => useUIStore.getState().openProjectDialog({ mode: 'create' })}
        />
        <ActionRow
          value="action:toggle-theme"
          icon={darkNow ? Sun : Moon}
          label="Toggle theme"
          hint={darkNow ? 'Switch to light' : 'Switch to dark'}
          onSelect={() => {
            setTheme(darkNow ? 'light' : 'dark')
            close()
          }}
        />
      </CommandGroup>
      <CommandGroup heading="Go to">
        <ActionRow
          value="action:go-overview"
          icon={LayoutDashboard}
          label="Go to Overview"
          shortcut={<Shortcut keys={SHORTCUTS.goOverview} />}
          onSelect={() => goTo('/overview')}
        />
        <ActionRow
          value="action:go-my-tasks"
          icon={ListTodo}
          label="Go to My Tasks"
          shortcut={<Shortcut keys={SHORTCUTS.goMyTasks} />}
          onSelect={() => goTo('/my-tasks')}
        />
        <ActionRow
          value="action:go-projects"
          icon={FolderKanban}
          label="Go to Projects"
          shortcut={<Shortcut keys={SHORTCUTS.goProjects} />}
          onSelect={() => goTo('/projects')}
        />
        <ActionRow
          value="action:go-timeline"
          icon={ChartGantt}
          label="Go to Timeline"
          shortcut={<Shortcut keys={SHORTCUTS.goTimeline} />}
          onSelect={() => goTo('/timeline')}
        />
        <ActionRow
          value="action:go-settings"
          icon={Settings}
          label="Go to Settings"
          onSelect={() => goTo('/settings')}
        />
      </CommandGroup>
      {recent.length > 0 ? (
        <CommandGroup heading="Recent projects">
          {recent.map((project) => (
            <RecentProjectRow key={project.id} project={project} onOpen={openProject} />
          ))}
        </CommandGroup>
      ) : null}
    </>
  )
}
