/**
 * The inline theme script in index.html runs under a strict CSP (no 'unsafe-inline' for
 * scripts), so public/_headers must allow-list its exact sha256. Any edit to the script must
 * update the hash — this test recomputes it.
 */
import { describe, expect, it } from 'vitest'
import headers from '../../public/_headers?raw'
import indexHtml from '../../index.html?raw'

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}

function cspDirectives(): Map<string, string> {
  const line = headers.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'))
  expect(line, 'Content-Security-Policy header missing').toBeDefined()
  const policy = (line as string).split('Content-Security-Policy:')[1]
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/)
        return [name, values.join(' ')] as const
      }),
  )
}

describe('Content-Security-Policy', () => {
  it('allow-lists the exact hash of every inline script in index.html', async () => {
    const scripts = inlineScripts(indexHtml)
    expect(scripts.length).toBeGreaterThan(0)
    const scriptSrc = cspDirectives().get('script-src') ?? ''
    for (const script of scripts) {
      expect(scriptSrc).toContain(`'sha256-${await sha256Base64(script)}'`)
    }
  })

  it('keeps the strict baseline directives', () => {
    const csp = cspDirectives()
    expect(csp.get('default-src')).toBe("'self'")
    expect(csp.get('script-src')).not.toContain('unsafe-inline')
    expect(csp.get('script-src')?.startsWith("'self'")).toBe(true)
    expect(csp.get('style-src')).toBe("'self' 'unsafe-inline'")
    expect(csp.get('img-src')).toBe("'self' data: blob:")
    expect(csp.get('font-src')).toBe("'self' data:")
    expect(csp.get('connect-src')).toBe("'self' https://*.supabase.co wss://*.supabase.co")
    expect(csp.get('frame-ancestors')).toBe("'none'")
    expect(csp.get('base-uri')).toBe("'self'")
    expect(csp.get('form-action')).toBe("'self'")
  })

  it('sends the other security headers', () => {
    expect(headers).toMatch(/X-Content-Type-Options: nosniff/)
    expect(headers).toMatch(/Referrer-Policy: strict-origin-when-cross-origin/)
    expect(headers).toMatch(/Permissions-Policy: camera=\(\), microphone=\(\), geolocation=\(\)/)
  })
})
