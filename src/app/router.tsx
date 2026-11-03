/**
 * Routes (docs/architecture.md §7). Pages are lazy-loaded by their named exports; redirects run
 * in loaders (no flash) and keep the query string, so `?task=<id>` deep links survive them.
 */
import type { ComponentType } from 'react'
import {
  createBrowserRouter,
  redirect,
  type LoaderFunctionArgs,
  type RouteObject,
} from 'react-router'
import { LoadingState } from '@/components/layout/LoadingState'
import { AppSplash } from './AppSplash'
import { AuthGate } from './AuthGate'
import { NotFoundPage } from './NotFoundPage'
import { ContentErrorBoundary, RootErrorBoundary } from './RouteErrorBoundary'
import type { RouteHandle } from './routeHandle'
import { AppShell } from './shell/AppShell'
import { getProjectView } from './viewPrefs'

export const MY_TASKS_TABS = ['today', 'upcoming', 'overdue', 'all'] as const
export const SETTINGS_SECTIONS = ['account', 'appearance', 'data'] as const

/** Loader that redirects to `to`, keeping the current query string (e.g. `?task=`). */
function redirectTo(to: string | ((args: LoaderFunctionArgs) => string)) {
  return (args: LoaderFunctionArgs) => {
    const target = typeof to === 'function' ? to(args) : to
    return redirect(`${target}${new URL(args.request.url).search}`)
  }
}

/** Index route that only redirects (`element: null` = nothing to render meanwhile). */
function redirectIndex(to: Parameters<typeof redirectTo>[0]): RouteObject {
  return { index: true, loader: redirectTo(to), element: null }
}

/** Redirects unknown `:param` values (e.g. /my-tasks/foo) to a default. */
function allowParam(name: string, allowed: readonly string[], fallback: string) {
  return (args: LoaderFunctionArgs) => {
    const value = args.params[name]
    return value && allowed.includes(value) ? null : redirectTo(fallback)(args)
  }
}

/**
 * Lazy route definition loading the module's named page component. When a chunk of an older
 * deploy is gone, the preload-error handler (./preloadRecovery) reloads the page and Vite then
 * resolves the import with `undefined`: keep the navigation pending until the reload replaces
 * the page, instead of flashing an error.
 */
function page<M extends Record<K, ComponentType>, K extends string>(
  load: () => Promise<M>,
  name: K,
) {
  return {
    Component: async () => {
      const module: M | undefined = await load()
      if (!module) return new Promise<never>(() => {})
      return module[name]
    },
  }
}

const handle = (crumb: RouteHandle['crumb']): RouteHandle => ({ crumb })

export const routes: RouteObject[] = [
  {
    id: 'root',
    HydrateFallback: AppSplash,
    ErrorBoundary: RootErrorBoundary,
    children: [
      {
        path: 'login',
        lazy: page(() => import('./LoginPage'), 'LoginPage'),
        handle: handle('Sign in'),
      },
      {
        Component: AuthGate,
        children: [
          {
            Component: AppShell,
            children: [
              {
                id: 'content',
                HydrateFallback: LoadingState,
                ErrorBoundary: ContentErrorBoundary,
                children: [
                  redirectIndex('/overview'),
                  {
                    path: 'overview',
                    lazy: page(() => import('@/features/overview/OverviewPage'), 'OverviewPage'),
                    handle: handle('Overview'),
                  },
                  {
                    path: 'my-tasks',
                    handle: handle('My Tasks'),
                    children: [
                      redirectIndex('/my-tasks/today'),
                      {
                        path: ':tab',
                        loader: allowParam('tab', MY_TASKS_TABS, '/my-tasks/today'),
                        lazy: page(() => import('@/features/my-tasks/MyTasksPage'), 'MyTasksPage'),
                      },
                    ],
                  },
                  {
                    path: 'projects',
                    handle: handle('Projects'),
                    children: [
                      {
                        index: true,
                        lazy: page(
                          () => import('@/features/projects/ProjectsPage'),
                          'ProjectsPage',
                        ),
                      },
                      {
                        path: ':projectId',
                        handle: handle(({ params, data }) =>
                          params.projectId && Object.hasOwn(data.projects, params.projectId)
                            ? data.projects[params.projectId].name
                            : null,
                        ),
                        lazy: page(
                          () => import('@/features/projects/ProjectLayout'),
                          'ProjectLayout',
                        ),
                        children: [
                          redirectIndex(
                            ({ params }) =>
                              `/projects/${encodeURIComponent(params.projectId ?? '')}/${getProjectView(params.projectId ?? '')}`,
                          ),
                          {
                            path: 'list',
                            lazy: page(() => import('@/features/list/ListView'), 'ListView'),
                          },
                          {
                            path: 'board',
                            lazy: page(() => import('@/features/board/BoardView'), 'BoardView'),
                          },
                          {
                            path: 'gantt',
                            lazy: page(() => import('@/features/gantt/GanttView'), 'GanttView'),
                          },
                        ],
                      },
                    ],
                  },
                  {
                    path: 'timeline',
                    lazy: page(() => import('@/features/timeline/TimelinePage'), 'TimelinePage'),
                    handle: handle('Timeline'),
                  },
                  {
                    path: 'settings',
                    handle: handle('Settings'),
                    children: [
                      redirectIndex('/settings/account'),
                      {
                        path: ':section',
                        loader: allowParam('section', SETTINGS_SECTIONS, '/settings/account'),
                        lazy: page(
                          () => import('@/features/settings/SettingsPage'),
                          'SettingsPage',
                        ),
                      },
                    ],
                  },
                  { path: '*', Component: NotFoundPage, handle: handle('Not found') },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
]

/** The app's browser router (created once). */
export const router = createBrowserRouter(routes)
