import { isRouteErrorResponse, useRouteError } from 'react-router'
import { ErrorState } from '@/components/layout/ErrorState'
import { NotFoundPage } from './NotFoundPage'

const STALE_CHUNK =
  /dynamically imported module|Importing a module script failed|error loading dynamically/i

function describe(error: unknown): { title: string; message: string } {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
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
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />
  const { title, message } = describe(error)
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ErrorState
        titleAs="h1"
        title={title}
        message={message}
        onRetry={reload}
        retryLabel="Reload"
      />
    </div>
  )
}

/** Last-resort boundary for errors outside the shell (e.g. the login page). */
export function RootErrorBoundary() {
  const error = useRouteError()
  const { title, message } = describe(error)
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
