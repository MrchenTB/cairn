import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchWithDeadline, REQUEST_TIMEOUT_MS } from './supabaseClient'

/** A fetch that never answers until its signal aborts, like a server that hangs. */
function hangingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }),
  )
}

describe('fetchWithDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('gives up on a request that never answers, as a failure of the request', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const request = fetchWithDeadline('https://example.test/auth/v1/token', { method: 'POST' })
    const outcome = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await outcome
  })

  it('also gives up on an answer whose body never finishes', async () => {
    const seen: { signal?: AbortSignal | null } = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.signal = init?.signal
        return new Response('{}')
      }),
    )
    await fetchWithDeadline('https://example.test/rest/v1/tasks')
    expect(seen.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
    expect(seen.signal?.aborted).toBe(true)
  })

  it("passes the caller's own abort on, and passes the request on unchanged", async () => {
    const fake = hangingFetch()
    vi.stubGlobal('fetch', fake)
    const caller = new AbortController()
    const request = fetchWithDeadline('https://example.test/x', {
      method: 'PATCH',
      body: '{}',
      headers: { Prefer: 'return=representation' },
      signal: caller.signal,
    })
    expect(fake.mock.calls[0][0]).toBe('https://example.test/x')
    expect(fake.mock.calls[0][1]).toMatchObject({
      method: 'PATCH',
      body: '{}',
      headers: { Prefer: 'return=representation' },
    })
    const outcome = expect(request).rejects.toBe('stopped')
    caller.abort('stopped')
    await outcome
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a caller that aborted before the request starts stops it at once', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const caller = new AbortController()
    caller.abort('too late')
    const fake = vi.mocked(fetch)
    fake.mockImplementationOnce(async (_input, init) => {
      if (init?.signal?.aborted) throw init.signal.reason
      return new Response('{}')
    })
    await expect(
      fetchWithDeadline('https://example.test/x', { signal: caller.signal }),
    ).rejects.toBe('too late')
  })

  it('a request that fails by itself leaves no timer behind', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(fetchWithDeadline('https://example.test/x')).rejects.toThrow('Failed to fetch')
    expect(vi.getTimerCount()).toBe(0)
  })
})
