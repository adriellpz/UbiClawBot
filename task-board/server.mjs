// Task Board server
// Container: TASKS_DIR=/app/vault/tasks PORT=3334 (set via compose env)
// Local dev: node server.mjs  (defaults to ../../agent-workspace-vault/tasks)

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = process.env.TASKS_DIR || path.resolve(__dirname, '../../agent-workspace-vault/tasks')
const PORT = Number(process.env.PORT || 3334)

// ── Frontmatter ──────────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { fm: {}, body: content }
  const fm = {}
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i === -1) continue
    const key = line.slice(0, i).trim()
    const val = line.slice(i + 1).trim()
    if (key) fm[key] = val
  }
  return { fm, body: match[2] }
}

function serializeFile(fm, body) {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n${body}`
}

// ── Path safety ───────────────────────────────────────────────────────────────

const TASKS_DIR_RESOLVED = path.resolve(TASKS_DIR)

function safeTaskPath(filename) {
  const resolved = path.resolve(TASKS_DIR_RESOLVED, filename)
  if (!resolved.startsWith(TASKS_DIR_RESOLVED + path.sep)) return null
  return resolved
}

// ── Task CRUD ────────────────────────────────────────────────────────────────

function readTasks() {
  return fs.readdirSync(TASKS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(filename => {
      try {
        const content = fs.readFileSync(path.join(TASKS_DIR, filename), 'utf8')
        const { fm } = parseFrontmatter(content)
        return {
          filename,
          title: fm.title || filename,
          status: fm.status || 'Backlog',
          due: fm.due || '',
          agent: fm.agent || '',
          created: fm.created || '',
          tags: fm.tags || '[]',
        }
      } catch { return null }
    })
    .filter(Boolean)
}

function patchTask(filename, fields) {
  const filepath = safeTaskPath(filename)
  if (!filepath) throw Object.assign(new Error('forbidden'), { status: 403 })
  const content = fs.readFileSync(filepath, 'utf8')
  const { fm, body } = parseFrontmatter(content)
  Object.assign(fm, fields)
  fs.writeFileSync(filepath, serializeFile(fm, body))
}

function createTask({ title, status = 'Backlog', due = '', agent = '' }) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
  const filename = `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`
  const today = new Date().toISOString().slice(0, 10)
  const content = serializeFile(
    { title, status, due, agent, created: today, tags: '[]' },
    '\n## Original Request\n\n\n## Research\n\n\n## Peer Review\n\n\n## Work completed\n\n'
  )
  fs.writeFileSync(path.join(TASKS_DIR, filename), content)
  return filename
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

async function body(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let s = ''
    req.on('data', c => {
      s += c
      if (Buffer.byteLength(s) > maxBytes) {
        req.destroy()
        reject(Object.assign(new Error('payload too large'), { status: 413 }))
      }
    })
    req.on('end', () => { try { resolve(JSON.parse(s)) } catch { resolve({}) } })
  })
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/healthz/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok', port: PORT, tasksDir: TASKS_DIR }))
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(HTML)
  }

  if (url.pathname === '/api/tasks') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(readTasks()))
    }
    if (req.method === 'POST') {
      try {
        const data = await body(req)
        const filename = createTask(data)
        res.writeHead(201, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ filename }))
      } catch (e) {
        res.writeHead(e.status || 500)
        return res.end(e.message)
      }
    }
  }

  const patch = url.pathname.match(/^\/api\/tasks\/(.+)$/)
  if (patch && req.method === 'PATCH') {
    try {
      const filename = decodeURIComponent(patch[1])
      const data = await body(req)
      patchTask(filename, data)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    } catch (e) {
      res.writeHead(e.status || 500)
      return res.end(e.message)
    }
  }

  res.writeHead(404)
  res.end('not found')
}).listen(PORT, () => {
  console.log(`Task board → http://localhost:${PORT}`)
  console.log(`Tasks dir  → ${TASKS_DIR}`)
})
