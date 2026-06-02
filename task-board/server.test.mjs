import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitFor(url, { timeoutMs = 10_000 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function startServer(tasksDir) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, TASKS_DIR: tasksDir, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let port
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server start timeout')), 10_000)
    child.stdout.on('data', chunk => {
      const m = String(chunk).match(/Task board → http:\/\/localhost:(\d+)/)
      if (m) { port = Number(m[1]); clearTimeout(timeout); resolve() }
    })
    child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited ${code}`)) })
  })
  return { child, url: `http://localhost:${port}` }
}

async function stopServer(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await once(child, 'exit').catch(() => {})
}

function tmpTasksDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-board-test-'))
}

function writeTask(dir, filename, fm, body = '') {
  const lines = Object.entries(fm).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}:\n${v.map(i => `  - ${i}`).join('\n')}`
    return `${k}: ${v}`
  })
  fs.writeFileSync(path.join(dir, filename), `---\n${lines.join('\n')}\n---\n${body}`)
}

function readFm(dir, filename) {
  const content = fs.readFileSync(path.join(dir, filename), 'utf8')
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const fm = {}
  let currentKey = null
  let currentList = null
  for (const line of match[1].split('\n')) {
    const listItem = line.match(/^  - (.+)$/)
    if (listItem) {
      if (currentList) currentList.push(listItem[1])
      continue
    }
    const kvMatch = line.match(/^([^:]+):\s*(.*)$/)
    if (!kvMatch) continue
    currentKey = kvMatch[1].trim()
    const val = kvMatch[2].trim()
    if (val === '') {
      currentList = []
      fm[currentKey] = currentList
    } else {
      currentList = null
      fm[currentKey] = val
    }
  }
  return fm
}

async function json(res) {
  return res.json()
}

// ── Link endpoint tests ───────────────────────────────────────────────────────

test('POST /links: creates forward and reverse blocks link', async () => {
  const dir = tmpTasksDir()
  writeTask(dir, 'source.md', { title: 'Source', status: 'In Progress' })
  writeTask(dir, 'target.md', { title: 'Target', status: 'Backlog' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks/source.md/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'blocks', targetFilename: 'target.md' }),
    })
    assert.equal(r.status, 200)
    const data = await json(r)
    assert.equal(data.ok, true)

    const srcFm = readFm(dir, 'source.md')
    const tgtFm = readFm(dir, 'target.md')
    assert.ok(Array.isArray(srcFm.blocks) ? srcFm.blocks.some(v => v.includes('target')) : String(srcFm.blocks).includes('target'), 'source.blocks should contain target')
    assert.ok(Array.isArray(tgtFm['blocked-by']) ? tgtFm['blocked-by'].some(v => v.includes('source')) : String(tgtFm['blocked-by']).includes('source'), 'target.blocked-by should contain source')
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})

test('POST /links: creates parent/child link', async () => {
  const dir = tmpTasksDir()
  writeTask(dir, 'parent.md', { title: 'Parent', status: 'In Progress' })
  writeTask(dir, 'child.md', { title: 'Child', status: 'Backlog' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks/child.md/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'parent', targetFilename: 'parent.md' }),
    })
    assert.equal(r.status, 200)

    const childFm = readFm(dir, 'child.md')
    const parentFm = readFm(dir, 'parent.md')
    assert.ok(String(childFm.parent).includes('parent'), 'child.parent should contain parent')
    assert.ok(Array.isArray(parentFm.children) ? parentFm.children.some(v => v.includes('child')) : String(parentFm.children).includes('child'), 'parent.children should contain child')
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})

test('POST /links: related link written symmetrically', async () => {
  const dir = tmpTasksDir()
  writeTask(dir, 'a.md', { title: 'A', status: 'Backlog' })
  writeTask(dir, 'b.md', { title: 'B', status: 'Backlog' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks/a.md/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'related', targetFilename: 'b.md' }),
    })
    assert.equal(r.status, 200)

    const aFm = readFm(dir, 'a.md')
    const bFm = readFm(dir, 'b.md')
    assert.ok(Array.isArray(aFm.related) ? aFm.related.some(v => v.includes('b')) : String(aFm.related).includes('b'), 'a.related should contain b')
    assert.ok(Array.isArray(bFm.related) ? bFm.related.some(v => v.includes('a')) : String(bFm.related).includes('a'), 'b.related should contain a')
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})

test('DELETE /links: removes both sides of blocks link', async () => {
  const dir = tmpTasksDir()
  writeTask(dir, 'source.md', { title: 'Source', status: 'In Progress', blocks: '[[target|Target]]' })
  writeTask(dir, 'target.md', { title: 'Target', status: 'Backlog', 'blocked-by': '[[source|Source]]' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks/source.md/links`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'blocks', targetFilename: 'target.md' }),
    })
    assert.equal(r.status, 200)

    const srcFm = readFm(dir, 'source.md')
    const tgtFm = readFm(dir, 'target.md')
    const srcBlocks = srcFm.blocks
    const tgtBlockedBy = tgtFm['blocked-by']
    assert.ok(!srcBlocks || (Array.isArray(srcBlocks) ? srcBlocks.every(v => !v.includes('target')) : !String(srcBlocks).includes('target')), 'source.blocks should not contain target')
    assert.ok(!tgtBlockedBy || (Array.isArray(tgtBlockedBy) ? tgtBlockedBy.every(v => !v.includes('source')) : !String(tgtBlockedBy).includes('source')), 'target.blocked-by should not contain source')
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})

test('POST /links: rejects unknown type with 400', async () => {
  const dir = tmpTasksDir()
  writeTask(dir, 'a.md', { title: 'A', status: 'Backlog' })
  writeTask(dir, 'b.md', { title: 'B', status: 'Backlog' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks/a.md/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'successor', targetFilename: 'b.md' }),
    })
    assert.equal(r.status, 400)
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})

test('POST /links: rejects path traversal target with 403', async () => {
  const dir = tmpTasksDir()
  writeTask(dir, 'a.md', { title: 'A', status: 'Backlog' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks/a.md/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'blocks', targetFilename: '../../../etc/passwd' }),
    })
    assert.equal(r.status, 403)
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})

test('POST /links parent: rejects if target task is Done', async () => {
  const dir = tmpTasksDir()
  writeTask(dir, 'child.md', { title: 'Child', status: 'Backlog' })
  writeTask(dir, 'done-parent.md', { title: 'Done Parent', status: 'Done' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks/child.md/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'parent', targetFilename: 'done-parent.md' }),
    })
    assert.equal(r.status, 409)
    const data = await json(r)
    assert.equal(data.error, 'parent_done')
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})

test('POST /links parent: rejects if source already has a parent', async () => {
  const dir = tmpTasksDir()
  writeTask(dir, 'child.md', { title: 'Child', status: 'Backlog', parent: '[[existing-parent|Existing]]' })
  writeTask(dir, 'existing-parent.md', { title: 'Existing', status: 'In Progress' })
  writeTask(dir, 'new-parent.md', { title: 'New Parent', status: 'In Progress' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks/child.md/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'parent', targetFilename: 'new-parent.md' }),
    })
    assert.equal(r.status, 409)
    const data = await json(r)
    assert.equal(data.error, 'already_has_parent')
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})

test('PATCH status Done: blocked when a child is open', async () => {
  const dir = tmpTasksDir()
  writeTask(dir, 'parent.md', { title: 'Parent', status: 'In Progress', children: ['[[child|Child]]'] })
  writeTask(dir, 'child.md', { title: 'Child', status: 'In Progress', parent: '[[parent|Parent]]' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks/parent.md`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Done' }),
    })
    assert.equal(r.status, 409)
    const data = await json(r)
    assert.equal(data.error, 'children_not_done')
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})

test('PATCH status Done: parent auto-advances when last child goes Done', async () => {
  const dir = tmpTasksDir()
  writeTask(dir, 'parent.md', { title: 'Parent', status: 'In Progress', children: ['[[child|Child]]'] })
  writeTask(dir, 'child.md', { title: 'Child', status: 'In Progress', parent: '[[parent|Parent]]' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks/child.md`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Done' }),
    })
    assert.equal(r.status, 200)

    const parentFm = readFm(dir, 'parent.md')
    assert.equal(parentFm.status, 'Done')
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})

test('GET /api/tasks: isBlocked computed from blocked-by links', async () => {
  const dir = tmpTasksDir()
  writeTask(dir, 'blocker.md', { title: 'Blocker', status: 'In Progress' })
  writeTask(dir, 'blocked.md', { title: 'Blocked', status: 'Backlog', 'blocked-by': '[[blocker|Blocker]]' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks`)
    assert.equal(r.status, 200)
    const tasks = await json(r)
    const blocked = tasks.find(t => t.filename === 'blocked.md')
    assert.ok(blocked, 'blocked.md should be in task list')
    assert.equal(blocked.isBlocked, true)
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})

test('GET /api/tasks: isBlocked false when blocker is Done', async () => {
  const dir = tmpTasksDir()
  writeTask(dir, 'blocker.md', { title: 'Blocker', status: 'Done' })
  writeTask(dir, 'blocked.md', { title: 'Blocked', status: 'Backlog', 'blocked-by': '[[blocker|Blocker]]' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks`)
    const tasks = await json(r)
    const blocked = tasks.find(t => t.filename === 'blocked.md')
    assert.equal(blocked.isBlocked, false)
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})

test('GET /api/tasks: isBlocked false when blocker is absent (archived)', async () => {
  const dir = tmpTasksDir()
  // archived-task.md does NOT exist in tasks dir
  writeTask(dir, 'blocked.md', { title: 'Blocked', status: 'Backlog', 'blocked-by': '[[archived-task|Old Task]]' })
  const { child, url } = await startServer(dir)
  try {
    const r = await fetch(`${url}/api/tasks`)
    const tasks = await json(r)
    const blocked = tasks.find(t => t.filename === 'blocked.md')
    assert.equal(blocked.isBlocked, false)
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true })
  }
})
