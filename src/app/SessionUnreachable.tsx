import { useEffect, useState } from 'react'
import { WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/data/hooks'
import { AuthLayout } from './AuthLayout'

/**
 * The stored session could not be confirmed because the server did not answer (auth status
 * `unreachable`). Not a sign-out: the session stays on this device and nothing is shown or
 * cleared until it is confirmed. Tries again on the button and once whenever the browser comes
 * back online; never on a timer, so a server that stays down cannot cause a loop.
 */
export function SessionUnreachable() {
  const { actions } = useAuth()
  const [trying, setTrying] = useState(false)

  const retry = () => {
    setTrying(true)
    void actions.retrySession().finally(() => setTrying(false))
  }

  useEffect(() => {
    const onOnline = () => void actions.retrySession()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [actions])

  useEffect(() => {
    document.title = 'Can’t reach Cairn · Cairn'
  }, [])

  return (
    <AuthLayout title="Can’t reach Cairn" subtitle="Plan clearly. Work simply.">
      <div className="flex flex-col items-center text-center" role="status">
        <WifiOff className="size-6 text-fg-tertiary" strokeWidth={1.5} aria-hidden />
        <p className="mt-3 text-ui text-fg-secondary">
          You’re still signed in on this device, but the server didn’t answer. Check your connection
          and try again.
        </p>
        <Button
          variant="primary"
          size="md"
          className="mt-5 w-full"
          onClick={retry}
          disabled={trying}
        >
          {trying ? 'Trying…' : 'Try again'}
        </Button>
      </div>
    </AuthLayout>
  )
}
