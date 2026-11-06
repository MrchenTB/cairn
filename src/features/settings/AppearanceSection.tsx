/** Settings → Appearance: theme, time zone (Today / Overdue), first day of the week. */
import { useCallback, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'
import { useActions, usePreferences, useToday } from '@/data/hooks'
import { formatDate, getBrowserTimeZone } from '@/domain/dates'
import type { Preferences, ThemePreference } from '@/domain/types'
import { SettingRow, SettingsGroup } from './SettingsLayout'
import { TimeZoneField } from './TimeZoneField'

const THEME_OPTIONS: readonly SegmentedOption<ThemePreference>[] = [
  { value: 'system', label: 'System', icon: <Monitor /> },
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
]

type Weekday = 'monday' | 'sunday'
const WEEK_OPTIONS: readonly SegmentedOption<Weekday>[] = [
  { value: 'monday', label: 'Monday' },
  { value: 'sunday', label: 'Sunday' },
]

export function AppearanceSection() {
  const preferences = usePreferences()
  const actions = useActions()
  const today = useToday()
  const browserZone = getBrowserTimeZone()
  const [error, setError] = useState<string | null>(null)

  /**
   * Saves a preference. The store applies it at once and, if saving fails, rolls it back and
   * toasts with Retry itself; only a rejected value (validation) needs words next to the field.
   */
  const save = useCallback(
    async (patch: Partial<Preferences>) => {
      setError(null)
      const result = await actions.updatePreferences(patch)
      if (!result.ok && result.error.kind === 'validation') setError(result.error.message)
    },
    [actions],
  )

  const usingBrowserZone = preferences.timezone === browserZone

  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup title="Appearance" description="How Cairn looks and which days it counts.">
        <SettingRow
          title="Theme"
          description="System follows your operating system's light or dark setting."
        >
          <SegmentedControl
            aria-label="Theme"
            value={preferences.theme}
            onValueChange={(theme) => void save({ theme })}
            options={THEME_OPTIONS}
          />
        </SettingRow>
        <SettingRow title="Week starts on" description="Used by calendars and the Gantt timeline.">
          <SegmentedControl
            aria-label="Week starts on"
            value={preferences.weekStartsOn === 1 ? 'monday' : 'sunday'}
            onValueChange={(day) => void save({ weekStartsOn: day === 'monday' ? 1 : 0 })}
            options={WEEK_OPTIONS}
          />
        </SettingRow>
        <SettingRow
          stacked
          title="Time zone"
          description="Decides what counts as Today, Due soon and Overdue — the same on every device you sign in on. Task dates are plain calendar days and never shift."
        >
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <TimeZoneField
                value={preferences.timezone}
                onChange={(timezone) => void save({ timezone })}
              />
              <Button
                variant="secondary"
                size="md"
                disabled={usingBrowserZone}
                onClick={() => void save({ timezone: browserZone })}
              >
                Use browser time zone
              </Button>
            </div>
            <p className="text-meta text-fg-tertiary">
              {usingBrowserZone
                ? `Matches this browser (${browserZone}).`
                : `This browser is set to ${browserZone}.`}{' '}
              Today is {formatDate(today, 'long')} in {preferences.timezone}.
            </p>
            {error ? (
              <p role="alert" className="text-meta text-danger">
                {error}
              </p>
            ) : null}
          </div>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
