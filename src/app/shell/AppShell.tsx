import { useEffect } from 'react'
import { Outlet, useMatch } from 'react-router'
import { ErrorState } from '@/components/layout/ErrorState'
import { LoadingState } from '@/components/layout/LoadingState'
import { useProject } from '@/data/hooks'
import { MilestoneDialogHost } from '@/features/milestones/MilestoneDialogHost'
import { ProjectDialogHost } from '@/features/projects/ProjectDialogHost'
import { SearchOverlay } from '@/features/search/SearchOverlay'
import { TaskModalHost } from '@/features/task-modal/TaskModalHost'
import { useCurrentProjectId, useGlobalShortcuts } from '../shortcuts'
import { useWorkspaceBootstrap } from '../useWorkspaceBootstrap'
import { isProjectView, recordProjectVisit, setProjectView } from '../viewPrefs'
import { ShortcutsDialog } from './ShortcutsDialog'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

/** Remembers visited projects (sidebar "Recent") and each project's last view. */
function useProjectRouteMemory() {
  const projectId = useCurrentProjectId()
  const view = useMatch('/projects/:projectId/:view')?.params.view
  const exists = useProject(projectId) !== undefined
  useEffect(() => {
    if (projectId && exists) recordProjectVisit(projectId)
  }, [projectId, exists])
  useEffect(() => {
    if (projectId && exists && isProjectView(view)) setProjectView(projectId, view)
  }, [projectId, view, exists])
}

/**
 * Signed-in app frame: sidebar on the app layer + the main content as an inset rounded panel
 * (8px gap, 12px radius, subtle border) with the 44px top bar. The main area shows the page,
 * a skeleton while the workspace loads, or an error with Retry. Global hosts are mounted once;
 * feature hosts mount after the first successful load so deep links (?task=…) resolve.
 */
export function AppShell() {
  useGlobalShortcuts()
  useProjectRouteMemory()
  const boot = useWorkspaceBootstrap()

  return (
    <div className="flex h-dvh overflow-hidden bg-app text-fg">
      <a
        href="#main"
        className="sr-only rounded-md bg-elevated px-3 py-2 text-ui font-medium text-fg shadow-popover focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-(--z-toast)"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col py-(--shell-gap) pr-(--shell-gap)">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-subtle bg-main shadow-panel">
          <TopBar />
          <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col focus:outline-none">
            {boot.status === 'ready' ? (
              <Outlet />
            ) : boot.status === 'error' ? (
              <ErrorState
                title="Couldn’t load your workspace"
                message={boot.error?.message}
                onRetry={boot.retry}
                retrying={boot.retrying}
              />
            ) : (
              <LoadingState />
            )}
          </main>
        </div>
      </div>
      <ShortcutsDialog />
      {boot.loadedOnce ? (
        <>
          <TaskModalHost />
          <SearchOverlay />
          <ProjectDialogHost />
          <MilestoneDialogHost />
        </>
      ) : null}
    </div>
  )
}
