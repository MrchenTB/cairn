/**
 * Vite inlines `import.meta.env` read as a value as one object holding EVERY VITE_* variable, so
 * a secret that someone puts in any VITE_ variable would ship in the bundle even if the app never
 * uses it. Only these named, public values may be read.
 */
import { describe, expect, it } from 'vitest'

const READABLE = new Set([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_DATA_MODE',
  'MODE',
  'DEV',
  'PROD',
])

const sources = import.meta.glob<string>('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('environment variables in the bundle', () => {
  it('app code reads only named public variables, never the whole import.meta.env', () => {
    const appFiles = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path))
    expect(appFiles.length).toBeGreaterThan(50)
    const problems: string[] = []
    for (const [path, code] of appFiles) {
      for (const match of withoutComments(code).matchAll(/import\.meta\.env(?:\.(\w+))?/g)) {
        if (!match[1] || !READABLE.has(match[1])) problems.push(`${path}: ${match[0]}`)
      }
    }
    expect(problems).toEqual([])
  })
})
