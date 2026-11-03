import { Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip } from '@/components/ui/tooltip'
import type { ThemePreference } from '@/domain/types'
import { useTheme } from '../theme'

const OPTIONS: Record<ThemePreference, { label: string; icon: typeof Sun }> = {
  light: { label: 'Light', icon: Sun },
  dark: { label: 'Dark', icon: Moon },
  system: { label: 'System', icon: Monitor },
}
const MENU_ORDER: readonly ThemePreference[] = ['light', 'dark', 'system']

/** Top-bar theme switcher: Light / Dark / System (follows the OS). */
export function ThemeMenu() {
  const { preference, resolved, setPreference } = useTheme()
  const TriggerIcon = preference === 'system' ? Monitor : resolved === 'dark' ? Moon : Sun
  const label = `Theme: ${OPTIONS[preference].label}`

  return (
    <DropdownMenu>
      <Tooltip content={label} side="bottom">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={label}>
            <TriggerIcon strokeWidth={1.75} />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => setPreference(value as ThemePreference)}
        >
          {MENU_ORDER.map((theme) => {
            const { label, icon: Icon } = OPTIONS[theme]
            return (
              <DropdownMenuRadioItem key={theme} value={theme}>
                <Icon />
                {label}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
