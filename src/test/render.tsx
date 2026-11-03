/**
 * Test render helper for components that need app-level providers: tooltips always, and a
 * memory router when `route` is given (so links and router hooks work).
 */
import type { ReactElement, ReactNode } from 'react'
import { render, type RenderOptions } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { TooltipProvider } from '@/components/ui/tooltip'

export interface RenderUIOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Render inside a memory router at this URL (route pattern '*'). */
  route?: string
}

/** Renders `ui` with TooltipProvider (+ router) and returns a user-event instance too. */
export function renderUI(ui: ReactElement, { route, ...options }: RenderUIOptions = {}) {
  const user = userEvent.setup()
  const wrap = (node: ReactNode) => <TooltipProvider delayDuration={0}>{node}</TooltipProvider>
  if (route === undefined) {
    return { user, ...render(wrap(ui), options) }
  }
  const router = createMemoryRouter([{ path: '*', element: wrap(ui) }], {
    initialEntries: [route],
  })
  return { user, router, ...render(<RouterProvider router={router} />, options) }
}
