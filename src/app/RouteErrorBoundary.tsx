import { isRouteErrorResponse, useLocation, useNavigate, useRouteError } from 'react-router'
import { ErrorState } from '@/components/layout/ErrorState'
import { NotFoundPage } from './NotFoundPage'

const STALE_CHUNK =
  /dynamically imported module|Importing a module script failed|error loading dynamically/i

function describe(error: unknown, offline: boolean): { title: string; message: string } {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (STALE_CHUNK.test(text) && offline) {
    // Not a new version: this page's code has not been loaded yet and cannot be fetched offline.
    return {
      title: "You're offline",
      message:
        "This page isn't loaded yet and needs a connection to open. Your saved data is safe: reconnect, then try again.",
    }
  }
  if (STALE_CHUNK.test(text)) {
    return {
      title: 'A new version of Cairn is available',
      message: 'Reload the page to continue.',
    }
  }
  return {
    title: 'Something went wrong',
    message: 'This view failed to render. Reloading usually fixes it; your saved data is safe.',
  }
}

function reload() {
  window.location.reload()
}

/** Error boundary for pages inside the shell: the sidebar stays usable. */
export function ContentErrorBoundary() {
  const error = useRouteError()
  const location = useLocation()
  const navigate = useNavigate()
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />
  const offline = typeof navigator !== 'undefined' && !navigator.onLine
  const { title, message } = describe(error, offline)
  const text = error instanceof Error ? error.message : ''
  // Offline, reloading would replace the app with the browser's offline page: ask for the same
  // page again instead (a failed chunk import is retried by a new navigation).
  const again = offline && STALE_CHUNK.test(text)
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ErrorState
        titleAs="h1"
        title={title}
        message={message}
        onRetry={
          again
            ? () =>
                void navigate(`${location.pathname}${location.search}${location.hash}`, {
                  replace: true,
                })
            : reload
        }
        retryLabel={again ? 'Try again' : 'Reload'}
      />
    </div>
  )
}

/** Last-resort boundary for errors outside the shell (e.g. the login page). */
export function RootErrorBoundary() {
  const error = useRouteError()
  const { title, message } = describe(error, false)
  return (
    <main className="min-h-dvh bg-app">
      <ErrorState
        titleAs="h1"
        title={title}
        message={message}
        onRetry={reload}
        retryLabel="Reload"
      />
    </main>
  )
}
