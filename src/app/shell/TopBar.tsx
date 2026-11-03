import { Fragment, useEffect, useMemo } from 'react'
import { Link, useMatches } from 'react-router'
import { Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Shortcut } from '@/components/ui/kbd'
import { Tooltip } from '@/components/ui/tooltip'
import { useWorkspaceData } from '@/data/hooks'
import { cn } from '@/lib/utils'
import { collectCrumbs } from '../routeHandle'
import { SHORTCUTS, useCurrentProjectId } from '../shortcuts'
import { useUIStore } from '../uiStore'
import { ThemeMenu } from './ThemeMenu'

/** Location breadcrumb from route handles; also keeps document.title in sync. */
function Breadcrumbs({ className }: { className?: string }) {
  const matches = useMatches()
  const data = useWorkspaceData()
  const crumbs = useMemo(() => collectCrumbs(matches, data), [matches, data])
  const current = crumbs.at(-1)?.label

  useEffect(() => {
    document.title = current ? `${current} · Cairn` : 'Cairn'
  }, [current])

  return (
    <nav aria-label="Breadcrumb" className={cn('flex min-w-0 items-center', className)}>
      <ol className="flex min-w-0 items-center gap-1.5 text-ui">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1
          return (
            <Fragment key={crumb.to}>
              {index > 0 ? (
                <li aria-hidden className="shrink-0 text-fg-disabled">
                  /
                </li>
              ) : null}
              <li className="min-w-0">
                {isLast ? (
                  <span aria-current="page" className="block truncate font-medium text-fg">
                    {crumb.label}
                  </span>
                ) : (
                  <Link
                    to={crumb.to}
                    className="block truncate rounded-sm text-fg-tertiary transition-colors duration-fast hover:text-fg hover:duration-instant"
                  >
                    {crumb.label}
                  </Link>
                )}
              </li>
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * 44px location bar at the top of the main panel: breadcrumb on the left; Search (⌘K), theme
 * and a global "New task" on the right. Everything here is quiet (ghost): the page's own header
 * owns its primary action, so the location bar never competes with it (design §5.2/§5.3).
 * Its bottom hairline is the only header line.
 */
export function TopBar() {
  const searchOpen = useUIStore((s) => s.searchOpen)
  const setSearchOpen = useUIStore((s) => s.setSearchOpen)
  const openNewTask = useUIStore((s) => s.openNewTask)
  const projectId = useCurrentProjectId()

  return (
    <header className="flex h-(--topbar-height) shrink-0 items-center gap-1.5 border-b border-subtle pr-2.5 pl-4">
      <Breadcrumbs className="mr-2 flex-1" />
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={searchOpen}
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setSearchOpen(true)}
        className="gap-2 pr-1.5 pl-2 font-normal text-fg-tertiary"
      >
        <Search strokeWidth={1.75} />
        <span>Search</span>
        <Shortcut keys={SHORTCUTS.search} className="ml-1" />
      </Button>
      <ThemeMenu />
      <Tooltip content="New task" shortcut={SHORTCUTS.newTask} side="bottom">
        <Button
          variant="ghost"
          size="sm"
          aria-keyshortcuts="C"
          className="gap-1.5 pr-2.5 pl-2"
          onClick={() => openNewTask(projectId ? { projectId } : {})}
        >
          <Plus strokeWidth={1.75} />
          New task
        </Button>
      </Tooltip>
    </header>
  )
}
