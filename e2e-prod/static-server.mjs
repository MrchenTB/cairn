// Tiny static host that mimics Cloudflare Workers Static Assets for a Vite build: applies
// <root>/_headers (every matching rule) and the SPA fallback (unknown path -> index.html, status
// 200, also under /assets/). Usage: node e2e-prod/static-server.mjs <root> <port>
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

function parseHeaders(text) {
  const rules = []
  let current = null
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] }
      rules.push(current)
    } else if (current) {
      const at = line.indexOf(':')
      current.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()])
    }
  }
  return rules
}

function matches(pattern, path) {
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${escaped.join('.*')}$`).test(path)
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
const rules = parseHeaders(readFileSync(join(root, '_headers'), 'utf8'))

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
  const file =
    inside && decoded !== '/_headers' && isFile(candidate) ? candidate : join(root, 'index.html')
  const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }
  for (const rule of rules) {
    if (matches(rule.pattern, path)) {
      for (const [name, value] of rule.headers) headers[name.toLowerCase()] = value
    }
  }
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file))
}).listen(port, 'localhost')
