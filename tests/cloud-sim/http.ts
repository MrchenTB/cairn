/** Small helpers shared by the simulator's GoTrue and PostgREST layers. */

/** Thrown for anything the simulator does not implement: it must fail loudly, never guess. */
export class SimUnsupported extends Error {
  constructor(message: string) {
    super(`cloud-sim does not support ${message}`)
    this.name = 'SimUnsupported'
  }
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  })
}

/** The request body as JSON, or undefined when it is empty or malformed. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
