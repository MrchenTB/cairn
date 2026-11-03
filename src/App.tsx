import { RouterProvider } from 'react-router/dom'
import { ThemeProvider } from '@/app/ThemeProvider'
import { router } from '@/app/router'
import { useTheme } from '@/app/theme'
import { ConfirmHost } from '@/components/ui/confirm'
import { Toaster } from '@/components/ui/toaster'
import { TooltipProvider } from '@/components/ui/tooltip'

function ThemedToaster() {
  const { resolved } = useTheme()
  return <Toaster theme={resolved} />
}

/** Root component: theme, tooltips, router, and the hosts that live outside any route. */
export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <RouterProvider router={router} />
        <ThemedToaster />
        <ConfirmHost />
      </TooltipProvider>
    </ThemeProvider>
  )
}
