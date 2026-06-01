// Task Board server
// Container: TASKS_DIR=/vault/tasks PORT=3334 (set via compose env)
// Local dev: node server.mjs  (defaults to ../../agent-workspace-vault/tasks)

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import webpush from 'web-push'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = process.env.TASKS_DIR || path.resolve(__dirname, '../../agent-workspace-vault/tasks')
const PORT = Number(process.env.PORT || 3334)

// ── Push / hook config ────────────────────────────────────────────────────────

const VAPID_PUBLIC_KEY        = process.env.VAPID_PUBLIC_KEY || ''
const VAPID_PRIVATE_KEY       = process.env.VAPID_PRIVATE_KEY || ''
const VAPID_SUBJECT           = process.env.VAPID_SUBJECT || 'mailto:adriellpz@gmail.com'
const OPENCLAW_HOOK_URL       = process.env.OPENCLAW_HOOK_URL || ''
const OPENCLAW_HOOK_TOKEN     = process.env.OPENCLAW_HOOK_TOKEN || ''
const PUSH_SUBSCRIPTIONS_FILE = process.env.PUSH_SUBSCRIPTIONS_FILE || '/var/lib/task-board/push-subscriptions.json'

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
  console.log('Push       → VAPID configured')
} else {
  console.log('Push       → VAPID not configured (set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY)')
}

function loadSubscriptions() {
  try { return JSON.parse(fs.readFileSync(PUSH_SUBSCRIPTIONS_FILE, 'utf8')) } catch { return [] }
}

function saveSubscriptions(subs) {
  try {
    fs.mkdirSync(path.dirname(PUSH_SUBSCRIPTIONS_FILE), { recursive: true })
    fs.writeFileSync(PUSH_SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2))
  } catch (e) { console.error('saveSubscriptions failed:', e.message) }
}

// ── @mention dispatch ─────────────────────────────────────────────────────────

const MENTION_MAP = {
  '@ubi':    { type: 'hook', agentId: 'main' },
  '@cheryl': { type: 'hook', agentId: 'scheduler' },
  '@marcos': { type: 'hook', agentId: 'marcos' },
  '@adriel': { type: 'push' },
}

function extractMentions(text) {
  const found = new Set()
  for (const handle of Object.keys(MENTION_MAP)) {
    if (new RegExp(`(?<![a-z0-9])${handle}(?![a-z0-9])`, 'i').test(text)) found.add(handle)
  }
  return [...found]
}

async function wakeAgent(agentId, taskId, taskTitle, commentText) {
  if (!OPENCLAW_HOOK_URL || !OPENCLAW_HOOK_TOKEN) return
  const message = [
    'task_mention',
    `task: ${taskTitle}`,
    `task_id: ${taskId}`,
    `comment: ${String(commentText).slice(0, 500)}`,
    `url: /?card=${taskId}`,
  ].join('\n')
  try {
    const r = await fetch(OPENCLAW_HOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${OPENCLAW_HOOK_TOKEN}` },
      body: JSON.stringify({ message, agentId, sessionKey: `hook:task-mention:${taskId}` }),
    })
    if (!r.ok) console.error(`wakeAgent ${agentId} failed: ${r.status}`)
    else console.log(`wakeAgent  → ${agentId} for task ${taskId}`)
  } catch (e) { console.error(`wakeAgent ${agentId} error:`, e.message) }
}

async function sendMentionPush(taskId, taskTitle, commentText) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return
  const subs = loadSubscriptions()
  if (!subs.length) return
  const payload = JSON.stringify({
    title: `Mention in ${taskTitle}`,
    body: String(commentText).slice(0, 120),
    url: `/?card=${taskId}`,
  })
  const dead = []
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload)
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint)
      else console.error('sendMentionPush error:', e.message)
    }
  }
  if (dead.length) saveSubscriptions(subs.filter(s => !dead.includes(s.endpoint)))
}

function dispatchMentions(filename, commentText) {
  const mentions = extractMentions(commentText)
  if (!mentions.length) return
  try {
    const task = getTask(filename)
    for (const handle of mentions) {
      const action = MENTION_MAP[handle]
      if (action.type === 'hook') wakeAgent(action.agentId, task.id, task.title, commentText).catch(() => {})
      else if (action.type === 'push') sendMentionPush(task.id, task.title, commentText).catch(() => {})
    }
  } catch (e) { console.error('dispatchMentions error:', e.message) }
}

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
  // migrate legacy tags:[] array to tag:string
  if (!fm.tag && fm.tags) {
    try { const a = JSON.parse(fm.tags); fm.tag = Array.isArray(a) && a.length ? a[0] : '' } catch { fm.tag = '' }
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

// ── Change tracking ───────────────────────────────────────────────────────────

const AGENT_DISPLAY  = { main: 'Ubi', scheduler: 'Cheryl', marcos: 'Marcos', adriel: 'Adriel' }
const TRACKED_FIELDS = ['title', 'status', 'due', 'agent', 'tag', 'time_needed', 'calendar_link', 'priority']
const FIELD_LABELS   = { time_needed: 'time', calendar_link: 'calendar', tag: 'category' }

function displayAgent(v) { return AGENT_DISPLAY[String(v || '').toLowerCase()] || v || 'agent' }

const taskSnapshots  = new Map()  // filename → frontmatter snapshot
const ownWrites      = new Set()  // filenames written by this server (suppress watcher)
const watchDebounces = new Map()  // per-file debounce timers
const sseClients     = new Set()  // active SSE response objects
const diffStore      = new Map()  // diffId → { sectionName: { before, after } }
const DIFF_STORE_MAX = 500

function diffStoreSet(id, data) {
  if (diffStore.size >= DIFF_STORE_MAX) diffStore.delete(diffStore.keys().next().value)
  diffStore.set(id, data)
}

function notifyClients(filename) {
  const msg = `data: ${JSON.stringify({ filename })}\n\n`
  for (const res of sseClients) {
    try { res.write(msg) } catch { sseClients.delete(res) }
  }
}

function extractNotes(body) {
  const histIdx = body.indexOf('\n## History\n')
  const cmtIdx  = body.indexOf('\n## Comments\n')
  const end = Math.min(histIdx === -1 ? Infinity : histIdx, cmtIdx === -1 ? Infinity : cmtIdx)
  return (end === Infinity ? body : body.slice(0, end)).trim()
}

function notesHash(notes) {
  let h = 0
  for (let i = 0; i < notes.length; i++) h = (Math.imul(31, h) + notes.charCodeAt(i)) | 0
  return h
}

function captureSnapshot(filename) {
  try {
    const content = fs.readFileSync(path.join(TASKS_DIR, filename), 'utf8')
    const { fm, body } = parseFrontmatter(content)
    const snap = {}
    for (const k of TRACKED_FIELDS) snap[k] = fm[k] || ''
    const notes = extractNotes(body)
    snap._bodyHash = notesHash(notes)
    snap._notes    = notes
    return snap
  } catch { return null }
}

function diffSnapshots(prev, curr) {
  const fmChanges = TRACKED_FIELDS
    .filter(k => (prev[k] || '') !== (curr[k] || ''))
    .map(k => `${FIELD_LABELS[k] || k}: "${prev[k] || 'none'}" → "${curr[k] || 'none'}"`)
  const bodyChanged = prev._bodyHash !== curr._bodyHash
  return { fmChanges, bodyChanged }
}

function initSnapshots() {
  try {
    for (const filename of fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md'))) {
      const snap = captureSnapshot(filename)
      if (snap) taskSnapshots.set(filename, snap)
    }
    console.log(`Snapshots  → ${taskSnapshots.size} tasks indexed`)
  } catch (e) {
    console.error('initSnapshots failed:', e.message)
  }
}

function appendHistoryEntry(filename, line) {
  const filepath = safeTaskPath(filename)
  if (!filepath) return
  try {
    const content = fs.readFileSync(filepath, 'utf8')
    const { fm, body } = parseFrontmatter(content)
    const cmtMarker  = '\n## Comments\n'
    const histMarker = '\n## History\n'
    let newBody
    if (body.includes(histMarker)) {
      const cmtIdx = body.indexOf(cmtMarker)
      newBody = cmtIdx !== -1
        ? body.slice(0, cmtIdx) + '\n' + line + body.slice(cmtIdx)
        : body.trimEnd() + '\n' + line + '\n'
    } else if (body.includes(cmtMarker)) {
      const cmtIdx = body.indexOf(cmtMarker)
      newBody = body.slice(0, cmtIdx) + '\n\n## History\n\n' + line + body.slice(cmtIdx)
    } else {
      newBody = body.trimEnd() + '\n\n## History\n\n' + line + '\n'
    }
    ownWrites.add(filename)
    fs.writeFileSync(filepath, serializeFile(fm, newBody))
    const snap = captureSnapshot(filename)
    if (snap) taskSnapshots.set(filename, snap)
    setTimeout(() => ownWrites.delete(filename), 500)
  } catch (e) {
    console.error('appendHistoryEntry failed:', e.message)
  }
}

function watchTasks() {
  try {
    fs.watch(TASKS_DIR, (eventType, filename) => {
      if (!filename || !filename.endsWith('.md')) return
      if (ownWrites.has(filename)) return
      clearTimeout(watchDebounces.get(filename))
      watchDebounces.set(filename, setTimeout(() => {
        watchDebounces.delete(filename)
        if (ownWrites.has(filename)) return
        const curr = captureSnapshot(filename)
        if (!curr) return
        const prev = taskSnapshots.get(filename)
        if (!prev) { taskSnapshots.set(filename, curr); return }
        const { fmChanges, bodyChanged } = diffSnapshots(prev, curr)
        if (!fmChanges.length && !bodyChanged) return
        const author = displayAgent(curr.agent)
        const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
        const parts = [...fmChanges]
        if (bodyChanged) {
          const before = prev._notes || ''
          const after  = curr._notes || ''
          if (before !== after) {
            const diffId = randomBytes(5).toString('hex')
            diffStoreSet(diffId, { Notes: { before, after } })
            parts.push(`notes updated [diff:${diffId}]`)
          } else {
            parts.push('notes updated')
          }
        }
        const line = `[${ts} · ${author}] ${parts.join(' | ')}`
        taskSnapshots.set(filename, curr)
        appendHistoryEntry(filename, line)
        notifyClients(filename)
        console.log(`History    → ${filename}: ${parts.join(' | ')}`)
      }, 300))
    })
    console.log(`Watching   → ${TASKS_DIR}`)
  } catch (e) {
    console.error('watchTasks failed:', e.message)
  }
}

// ── Task CRUD ────────────────────────────────────────────────────────────────

function readTasks() {
  return fs.readdirSync(TASKS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(filename => {
      try {
        const content = fs.readFileSync(path.join(TASKS_DIR, filename), 'utf8')
        const { fm, body } = parseFrontmatter(content)
        return {
          filename,
          id: fm.id || '',
          title: fm.title || filename,
          status: fm.status || 'Backlog',
          due: fm.due || '',
          agent: fm.agent || '',
          created: fm.created || '',
          tag: fm.tag || '',
          calendar_link: fm.calendar_link || '',
          time_needed: fm.time_needed || '',
          priority: fm.priority || '',
          body,
        }
      } catch { return null }
    })
    .filter(Boolean)
}

function getTask(filename) {
  const filepath = safeTaskPath(filename)
  if (!filepath) throw Object.assign(new Error('forbidden'), { status: 403 })
  const content = fs.readFileSync(filepath, 'utf8')
  const { fm, body } = parseFrontmatter(content)
  return {
    filename,
    id: fm.id || '',
    title: fm.title || filename,
    status: fm.status || 'Backlog',
    due: fm.due || '',
    agent: fm.agent || '',
    created: fm.created || '',
    tag: fm.tag || '',
    calendar_link: fm.calendar_link || '',
    time_needed: fm.time_needed || '',
    priority: fm.priority || '',
    body,
  }
}

function findTaskByCardId(cardId) {
  const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md'))
  for (const filename of files) {
    try {
      const content = fs.readFileSync(path.join(TASKS_DIR, filename), 'utf8')
      const { fm } = parseFrontmatter(content)
      if (fm.id === cardId) return filename
    } catch {}
  }
  return null
}

function appendComment(filename, { text, author }) {
  const filepath = safeTaskPath(filename)
  if (!filepath) throw Object.assign(new Error('forbidden'), { status: 403 })
  const content = fs.readFileSync(filepath, 'utf8')
  const { fm, body } = parseFrontmatter(content)
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const line = `[${ts} · ${author || 'anon'}] ${String(text).trim()}`
  const newBody = body.includes('\n## Comments\n')
    ? body + '\n' + line
    : body + '\n\n## Comments\n\n' + line
  ownWrites.add(filename)
  fs.writeFileSync(filepath, serializeFile(fm, newBody))
  const snap = captureSnapshot(filename)
  if (snap) taskSnapshots.set(filename, snap)
  setTimeout(() => ownWrites.delete(filename), 500)
  dispatchMentions(filename, String(text))
}

const PATCH_ALLOWED = new Set(['title', 'status', 'due', 'agent', 'tag', 'time_needed', 'calendar_link', 'priority'])

function patchTask(filename, fields) {
  const filepath = safeTaskPath(filename)
  if (!filepath) throw Object.assign(new Error('forbidden'), { status: 403 })
  const content = fs.readFileSync(filepath, 'utf8')
  const { fm, body: existingBody } = parseFrontmatter(content)
  const { body: newBody, ...fmFields } = fields
  for (const [k, v] of Object.entries(fmFields)) {
    if (PATCH_ALLOWED.has(k)) fm[k] = v
  }
  ownWrites.add(filename)
  fs.writeFileSync(filepath, serializeFile(fm, newBody !== undefined ? newBody : existingBody))
  const snap = captureSnapshot(filename)
  if (snap) taskSnapshots.set(filename, snap)
  setTimeout(() => ownWrites.delete(filename), 500)
}

function genId() {
  return randomBytes(5).toString('hex')
}

function createTask({ title, status = 'Backlog', due = '', agent = '', tag = '' }) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
  const filename = `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`
  const today = new Date().toISOString().slice(0, 10)
  const id = genId()
  const content = serializeFile(
    { title, status, due, agent, tag, id, created: today },
    '\n## Original Request\n\n\n## Research\n\n\n## Peer Review\n\n\n## Work completed\n\n'
  )
  fs.writeFileSync(path.join(TASKS_DIR, filename), content)
  return filename
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const HTML     = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
const MANIFEST = fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')
const SW       = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8')
const ICON     = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8')

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

  if (req.method === 'GET' && url.pathname === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/manifest+json' })
    return res.end(MANIFEST)
  }

  if (req.method === 'GET' && url.pathname === '/sw.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    return res.end(SW)
  }

  if (req.method === 'GET' && url.pathname === '/icon.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' })
    return res.end(ICON)
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

  const cardRoute = url.pathname.match(/^\/api\/cards\/([a-z0-9]+)$/)
  if (cardRoute && req.method === 'GET') {
    const filename = findTaskByCardId(cardRoute[1])
    if (!filename) { res.writeHead(404); return res.end('not found') }
    try {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(getTask(filename)))
    } catch (e) {
      res.writeHead(e.status || 500)
      return res.end(e.message)
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/push/vapid-public-key') {
    if (!VAPID_PUBLIC_KEY) { res.writeHead(503); return res.end('push not configured') }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ key: VAPID_PUBLIC_KEY }))
  }

  if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
    try {
      const data = await body(req)
      if (!data.endpoint) { res.writeHead(400); return res.end('missing endpoint') }
      const subs = loadSubscriptions()
      if (!subs.find(s => s.endpoint === data.endpoint)) {
        subs.push(data)
        saveSubscriptions(subs)
      }
      res.writeHead(201, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    } catch (e) {
      res.writeHead(e.status || 500)
      return res.end(e.message)
    }
  }

  const commentRoute = url.pathname.match(/^\/api\/tasks\/(.+)\/comments$/)
  if (commentRoute && req.method === 'POST') {
    try {
      const filename = decodeURIComponent(commentRoute[1])
      const data = await body(req)
      appendComment(filename, data)
      res.writeHead(201, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    } catch (e) {
      res.writeHead(e.status || 500)
      return res.end(e.message)
    }
  }

  const taskRoute = url.pathname.match(/^\/api\/tasks\/(.+)$/)
  if (taskRoute) {
    const filename = decodeURIComponent(taskRoute[1])
    if (req.method === 'GET') {
      try {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(getTask(filename)))
      } catch (e) {
        res.writeHead(e.status || 500)
        return res.end(e.message)
      }
    }
    if (req.method === 'PATCH') {
      try {
        const data = await body(req)
        patchTask(filename, data)
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        res.writeHead(e.status || 500)
        return res.end(e.message)
      }
    }
    if (req.method === 'DELETE') {
      try {
        const filepath = safeTaskPath(filename)
        if (!filepath) throw Object.assign(new Error('forbidden'), { status: 403 })
        fs.unlinkSync(filepath)
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        res.writeHead(e.status || 500)
        return res.end(e.message)
      }
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/diff') {
    try {
      const data = await body(req)
      const diffId = randomBytes(5).toString('hex')
      diffStoreSet(diffId, data)
      res.writeHead(201, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ diffId }))
    } catch (e) {
      res.writeHead(e.status || 500)
      return res.end(e.message)
    }
  }

  const diffRoute = url.pathname.match(/^\/api\/diff\/([a-z0-9]+)$/)
  if (diffRoute && req.method === 'GET') {
    const data = diffStore.get(diffRoute[1])
    if (!data) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(data))
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type':  'text/event-stream',
      'cache-control': 'no-cache',
      'connection':    'keep-alive',
    })
    res.write(': connected\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  res.writeHead(404)
  res.end('not found')
}).listen(PORT, () => {
  console.log(`Task board → http://localhost:${PORT}`)
  console.log(`Tasks dir  → ${TASKS_DIR}`)
  initSnapshots()
  watchTasks()
  setInterval(() => {
    for (const res of sseClients) {
      try { res.write(': ping\n\n') } catch { sseClients.delete(res) }
    }
  }, 30000)
})
