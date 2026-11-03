import type { ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { LogoMark } from '@/components/brand/Logo'

export interface AuthLayoutProps {
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
}

/** Centred 380px card on the app layer, shared by sign-in and "Set a new password". */
export function AuthLayout({ title, subtitle, children }: AuthLayoutProps) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoMark tone="brand" size={40} title="Cairn" />
          <h1 className="mt-4 text-title font-semibold tracking-(--letter-spacing-title) text-fg">
            {title}
          </h1>
          {subtitle ? <p className="mt-1 text-ui text-fg-secondary">{subtitle}</p> : null}
        </div>
        <div className="rounded-xl border border-subtle bg-main p-6 shadow-panel">{children}</div>
      </div>
    </main>
  )
}

/** Inline form error (danger tint + icon), announced when it appears. */
export function FormAlert({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      className="flex items-start gap-2 rounded-md bg-danger-subtle px-2.5 py-2 text-ui text-danger"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}
