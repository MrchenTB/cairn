/** Settings → Data: sync status and backups. */
import { BackupCard } from './BackupCard'
import { SyncCard } from './SyncCard'

export function DataSection() {
  return (
    <div className="flex flex-col gap-8">
      <SyncCard />
      <BackupCard />
    </div>
  )
}
