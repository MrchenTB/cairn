/**
 * /settings/:section (account | appearance | data): a section list on the left, the section on
 * the right. Every control acts on real state — preferences go through the store (synced, rolled
 * back with a Retry toast when saving fails), the sync card shows the store's sync state, and
 * backups use the data layer's export / import.
 */
import type { ComponentType } from 'react'
import { useParams } from 'react-router'
import { Database, Palette, UserRound } from 'lucide-react'
import { PageBody, PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { NavTab, NavTabs } from '@/components/ui/tabs'
import { AccountSection } from './AccountSection'
import { AppearanceSection } from './AppearanceSection'
import { DataSection } from './DataSection'

const SECTIONS = [
  { id: 'account', label: 'Account', icon: UserRound, content: AccountSection },
  { id: 'appearance', label: 'Appearance', icon: Palette, content: AppearanceSection },
  { id: 'data', label: 'Data', icon: Database, content: DataSection },
] as const satisfies readonly {
  id: string
  label: string
  icon: ComponentType
  content: ComponentType
}[]

export function SettingsPage() {
  const { section } = useParams()
  const active = SECTIONS.find((candidate) => candidate.id === section) ?? SECTIONS[0]
  const Content = active.content

  return (
    <PageContainer>
      <PageHeader title="Settings" description="Account, appearance, sync and backups." />
      {/* Layout follows the width of the panel (the sidebar takes its share), not the window. */}
      <div className="@container flex flex-1 flex-col">
        <PageBody className="gap-6 @2xl:flex-row @2xl:gap-10">
          <NavTabs
            aria-label="Settings sections"
            className="flex-wrap @2xl:w-44 @2xl:shrink-0 @2xl:flex-col @2xl:flex-nowrap @2xl:items-stretch"
          >
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <NavTab key={id} to={`/settings/${id}`} className="@2xl:justify-start">
                <Icon aria-hidden />
                {label}
              </NavTab>
            ))}
          </NavTabs>
          <div className="@container min-w-0 max-w-[680px] flex-1">
            <Content key={active.id} />
          </div>
        </PageBody>
      </div>
    </PageContainer>
  )
}
