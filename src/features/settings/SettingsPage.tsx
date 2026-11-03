import { Settings } from 'lucide-react'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/empty-state'

/** PLACEHOLDER — replaced by the Settings feature (/settings/:section: account | appearance | data). */
export function SettingsPage() {
  return (
    <PageContainer>
      <PageHeader title="Settings" />
      <EmptyState
        icon={Settings}
        title="Coming soon"
        description="Account, appearance, sync status and backups."
      />
    </PageContainer>
  )
}
