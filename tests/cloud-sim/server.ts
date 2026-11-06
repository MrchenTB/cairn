/**
 * HTTP front of the cloud simulator: `node tests/cloud-sim/server.ts [--port 54399]`.
 * Started and stopped by playwright.cloud.config.ts. It also exits by itself after a long idle
 * period, so a killed test run can never leave it behind on a small machine.
 */
import { createServer } from 'node:http'
import { createCloudSim, DropConnection } from './sim.ts'

const portFlag = process.argv.indexOf('--port')
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 54399
const IDLE_EXIT_MS = 15 * 60_000

const origin = `http://127.0.0.1:${port}`
const sim = await createCloudSim({ url: origin })

let idleTimer: NodeJS.Timeout | undefined
function touch(): void {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    console.error('[cloud-sim] idle for too long, exiting')
    process.exit(0)
  }, IDLE_EXIT_MS)
}
touch()

const server = createServer(async (req, res) => {
  touch()
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS'
  try {
    const response = await sim.handle(
      new Request(`${origin}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      }),
    )
    // One connection per request. A browser silently re-sends a request whose reused connection
    // died (POST too), which would turn a planned "connection dropped" into a second delivery; the
    // fault action 'replay' covers that case on purpose.
    res.writeHead(response.status, { ...Object.fromEntries(response.headers), Connection: 'close' })
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    if (error instanceof DropConnection) {
      req.socket.destroy() // No answer at all: the browser sees a failed fetch.
      return
    }
    console.error('[cloud-sim] request failed', error)
    res.writeHead(500)
    res.end()
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[cloud-sim] listening on ${origin}`)
})

const stop = () => process.exit(0)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
