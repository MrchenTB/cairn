/// <reference lib="dom" />
import { expect, test as base, type Page } from '@playwright/test'

/** Every test fails on a CSP violation, a console error or an uncaught exception. */
export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = []
      await page.addInitScript(() => {
        const w = window as unknown as { __csp?: string[] }
        w.__csp = []
        document.addEventListener('securitypolicyviolation', (event) => {
          w.__csp?.push(`${event.effectiveDirective}: ${event.blockedURI}`)
        })
      })
      page.on('console', (message) => {
        if (message.type() === 'error' || /Content Security Policy/i.test(message.text())) {
          problems.push(`console.${message.type()}: ${message.text()}`)
        }
      })
      page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
      await use(problems)
      expect(problems, 'console errors / CSP violations / uncaught exceptions').toEqual([])
      const csp = await page
        .evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])
        .catch(() => [])
      expect(csp, 'securitypolicyviolation events').toEqual([])
    },
    { auto: true },
  ],
})

/** Forget failures a test provoked on purpose, so that the fixture checks only unexpected ones. */
export async function forgetExpectedProblems(page: Page, problems: string[]) {
  problems.length = 0
  await page.evaluate(() => {
    ;(window as unknown as { __csp: string[] }).__csp = []
  })
}
