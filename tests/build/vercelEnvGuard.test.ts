/**
 * The build-level proof of the environment guard: runs the real `vite build` as a child process
 * with simulated Vercel variables and checks whether it is refused. Only the build exit code and
 * output are checked; the keys are fake and never leave this process. A function test alone could
 * pass while vite.config.ts forgets to hand a variable to the guard.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')
const VITE = join(ROOT, 'node_modules/.bin/vite')
const PRODUCTION_URL = 'https://jwonoholnttckednwfwb.supabase.co'
const STAGING_URL = 'https://bvaydvvqtuykoznoljux.supabase.co'
const FAKE_KEY = 'sb_publishable_test_only'

const workDir = mkdtempSync(join(tmpdir(), 'cairn-build-guard-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

interface Scenario {
  vercelEnv?: string
  url?: string
  key?: string
  dataMode?: string
}

/** `vite build` into its own temporary folder, with exactly these variables. */
function build(name: string, scenario: Scenario): Promise<{ code: number | null; output: string }> {
  // Start from this process's environment (PATH etc.) but never inherit the variables under test.
  // Empty strings beat any .env file; VERCEL_ENV must be absent, not empty, on "this computer".
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VITE_SUPABASE_URL: scenario.url ?? '',
    VITE_SUPABASE_PUBLISHABLE_KEY: scenario.key ?? '',
    VITE_SUPABASE_ANON_KEY: '',
    VITE_DATA_MODE: scenario.dataMode ?? '',
  }
  delete env.VERCEL_ENV
  if (scenario.vercelEnv) env.VERCEL_ENV = scenario.vercelEnv

  return new Promise((done, fail) => {
    const child = spawn(VITE, ['build', '--outDir', join(workDir, name), '--emptyOutDir'], {
      cwd: ROOT,
      env,
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('error', fail)
    child.on('close', (code) => done({ code, output }))
  })
}

describe('vite build and VITE_DATA_MODE', { timeout: 120_000 }, () => {
  it('refuses a production build that forces local mode', async () => {
    const result = await build('production-local', {
      vercelEnv: 'production',
      url: PRODUCTION_URL,
      key: FAKE_KEY,
      dataMode: 'local',
    })
    expect(result.code).not.toBe(0)
    expect(result.output).toMatch(
      /Refusing to start: a production deployment cannot force local mode/,
    )
  })

  it('refuses a preview build that forces local mode', async () => {
    const result = await build('preview-local', {
      vercelEnv: 'preview',
      url: STAGING_URL,
      key: FAKE_KEY,
      dataMode: ' Local ',
    })
    expect(result.code).not.toBe(0)
    expect(result.output).toMatch(/Refusing to start: a preview deployment cannot force local mode/)
  })

  it('control: the same preview build without VITE_DATA_MODE succeeds', async () => {
    const result = await build('preview-ok', {
      vercelEnv: 'preview',
      url: STAGING_URL,
      key: FAKE_KEY,
    })
    expect(result.output).not.toMatch(/Refusing to start/)
    expect(result.code).toBe(0)
  })

  it('on this computer (no VERCEL_ENV), local mode can still be forced', async () => {
    const result = await build('computer-local', { dataMode: 'local' })
    expect(result.output).not.toMatch(/Refusing to start/)
    expect(result.code).toBe(0)
  })
})
