import { useEffect } from 'react'

/** While `enabled`, closing or reloading the tab gets the browser's "Leave site?" prompt. */
export function useUnloadPrompt(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Legacy browsers need a return value to show the prompt.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [enabled])
}
