/**
 * After the last spec: removes any test project still left in either account, removes the stored
 * sessions, and prints the measurements the run recorded (also in test-results/staging/metrics.json).
 */
import { deleteTestProjects, forgetSessions, readMetrics, type UserKey } from './api.ts'

export default async function globalTeardown(): Promise<void> {
  for (const user of ['A', 'B'] as UserKey[]) {
    try {
      const removed = await deleteTestProjects(user)
      if (removed > 0)
        console.log(`[staging] account ${user}: removed ${removed} leftover test project(s)`)
    } catch (error) {
      console.error(`[staging] cleanup of account ${user} failed: ${(error as Error).message}`)
    }
  }

  forgetSessions()

  const metrics = readMetrics()
  if (metrics.length === 0) return
  console.log('\n[staging] measurements (test-results/staging/metrics.json)')
  for (const metric of metrics) {
    const value = Number.isInteger(metric.value) ? metric.value : metric.value.toFixed(1)
    console.log(
      `  ${metric.id.padEnd(3)} ${metric.name.padEnd(34)} ${String(value).padStart(8)} ${metric.unit}` +
        (metric.note ? `  ${metric.note}` : ''),
    )
  }
}
