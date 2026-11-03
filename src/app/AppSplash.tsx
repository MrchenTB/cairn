import { LogoMark } from '@/components/brand/Logo'

/** Full-screen placeholder while the session or the first route chunk loads. */
export function AppSplash() {
  return (
    <div
      role="status"
      aria-label="Loading Cairn"
      className="grid h-dvh place-items-center bg-app text-fg-tertiary"
    >
      <LogoMark size={28} className="opacity-60 motion-safe:animate-fade-in-delayed" />
    </div>
  )
}
