// Tiny static host that mimics Vercel for a Vite build, driven by vercel.json (read from
// process.cwd()). Filesystem first: an existing file is served as is. Otherwise the first
// matching `rewrites` rule serves its destination file with status 200 (the SPA fallback, which
// excludes /assets/). Otherwise 404. The `headers` of every matching rule are applied, also on the
// 404. Usage: node e2e-prod/static-server.mjs <root> <port>
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

// Vercel's `source` patterns for the rules in vercel.json are valid JS regexes (path-to-regexp
// syntax, but only plain groups and lookaheads are used), so anchoring them is enough.
function matches(source, path) {
  return new RegExp('^' + source + '$').test(path)
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const root = resolve(process.argv[2])
const port = Number(process.argv[3])
const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'))
const rewrites = config.rewrites ?? []
const headerRules = config.headers ?? []

createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    decoded = path
  }
  const candidate = resolve(root, `.${decoded}`)
  const inside = candidate === root || candidate.startsWith(root + sep)
  let file = inside && isFile(candidate) ? candidate : null
  if (!file) {
    const rewrite = rewrites.find((rule) => matches(rule.source, path))
    if (rewrite) file = join(root, rewrite.destination)
  }
  const headers = {}
  for (const rule of headerRules) {
    if (matches(rule.source, path)) {
      for (const { key, value } of rule.headers) headers[key.toLowerCase()] = value
    }
  }
  if (!file || !isFile(file)) {
    res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' })
    res.end(req.method === 'HEAD' ? undefined : 'Not found')
    return
  }
  headers['content-type'] = MIME[extname(file)] ?? 'application/octet-stream'
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file))
}).listen(port, 'localhost')
