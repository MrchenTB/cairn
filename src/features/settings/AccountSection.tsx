/** Settings → Account: who is signed in (or local mode), how data is stored, sign out, about. */
import { useState } from 'react'
import { LogOut } from 'lucide-react'
import { LogoMark } from '@/components/brand/Logo'
import { confirm } from '@/components/ui/confirm'
import { useAuth, useDataMode, useSyncState } from '@/data/hooks'
import { taskDrafts } from '@/features/task-modal/autosave/taskDrafts'
import { APP_NAME, APP_TAGLINE, APP_VERSION } from './about'
import { BusyButton } from './BusyButton'
import { SettingRow, SettingsGroup } from './SettingsLayout'

export function AccountSection() {
  const mode = useDataMode()
  const { user, actions: auth } = useAuth()
  const sync = useSyncState()
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signOut = async () => {
    setError(null)
    // Text that can still go out goes out first; what can't is named, because it won't survive.
    taskDrafts.flushAll()
    const unsaved = taskDrafts.getOutstanding().length
    const agreed = await confirm({
      title: 'Sign out of Cairn?',
      description: [
        unsaved > 0
          ? `${unsaved === 1 ? '1 unsaved text' : `${unsaved} unsaved texts`} in your tasks will be discarded.`
          : null,
        sync.pending > 0
          ? `${sync.pending === 1 ? '1 change is' : `${sync.pending} changes are`} still being saved. Cairn waits a moment for ${sync.pending === 1 ? 'it' : 'them'} before signing you out. Your data stays in the cloud.`
          : 'You will need to sign in again on this device. Your data stays in the cloud.',
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Sign out',
    })
    if (!agreed) return
    setSigningOut(true)
    const result = await auth.signOut()
    setSigningOut(false)
    // On success the auth gate takes over and this page goes away.
    if (result.ok) taskDrafts.purgeStored()
    else setError(result.error.message)
  }

  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup title="Account" description="Who you are and where your data lives.">
        {mode === 'supabase' ? (
          <>
            <SettingRow title="Signed in as">
              <span className="min-w-0 truncate text-ui text-fg">
                {user?.email ?? 'Your account'}
              </span>
            </SettingRow>
            <SettingRow
              title="Cloud sync"
              description="Your projects and tasks are saved to your Supabase project, protected by row-level security so only you can read them, and they appear on every device you sign in on."
            />
            <SettingRow
              title="Sign out"
              description="Ends the session on this device. Your data stays in the cloud."
            >
              <div className="flex flex-col items-end gap-1.5">
                <BusyButton
                  variant="secondary"
                  size="md"
                  busy={signingOut}
                  icon={<LogOut aria-hidden />}
                  onClick={() => void signOut()}
                >
                  Sign out
                </BusyButton>
                {error ? (
                  <p role="alert" className="max-w-xs text-right text-meta text-danger">
                    {error}
                  </p>
                ) : null}
              </div>
            </SettingRow>
          </>
        ) : (
          <>
            <SettingRow title="Account">
              <span className="text-ui text-fg">Local mode — data stays in this browser</span>
            </SettingRow>
            <SettingRow
              title="How your data is stored"
              description="Everything is kept in this browser's storage. Nothing is uploaded, other devices can't see it, and clearing the site's data deletes it. There is no account, so there is nothing to sign out of. Export a backup from Settings → Data to keep a copy."
            />
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="About">
        <SettingRow
          title={
            <span className="inline-flex items-center gap-2">
              <LogoMark size={20} tone="brand" />
              {APP_NAME}
            </span>
          }
          description={APP_TAGLINE}
        >
          <span className="text-ui text-fg-secondary tabular-nums">Version {APP_VERSION}</span>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
