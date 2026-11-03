import { Link } from 'react-router'
import { Compass } from 'lucide-react'
import { PageContainer } from '@/components/layout/PageContainer'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

/** Unknown URL inside the app shell. */
export function NotFoundPage() {
  return (
    <PageContainer>
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="This page doesn’t exist or has moved."
        action={
          <Button asChild variant="secondary" size="md">
            <Link to="/overview">Go to Overview</Link>
          </Button>
        }
      />
    </PageContainer>
  )
}
