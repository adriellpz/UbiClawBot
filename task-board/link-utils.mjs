// Pure wikilink parser and cascade rules — no filesystem dependency

// ── Wikilink format ───────────────────────────────────────────────────────────

export function parseWikilink(str) {
  const inner = str.replace(/^\[\[/, '').replace(/\]\]$/, '')
  const pipeIdx = inner.indexOf('|')
  if (pipeIdx === -1) return { filename: inner, title: inner }
  return { filename: inner.slice(0, pipeIdx), title: inner.slice(pipeIdx + 1) }
}

export function formatWikilink(filename, title) {
  return `[[${filename}|${title}]]`
}

export function parseLinkList(value) {
  if (value == null) return []
  const items = Array.isArray(value) ? value : [value]
  const result = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed.startsWith('[[') || !trimmed.endsWith(']]')) continue
    const parsed = parseWikilink(trimmed)
    if (!parsed.filename) continue
    result.push(parsed)
  }
  return result
}

export function formatLinkList(links) {
  return links.map(({ filename, title }) => formatWikilink(filename, title))
}

// ── Cascade rules ─────────────────────────────────────────────────────────────

// taskIndex: Map<filename, { status: string, children: Array<{ filename, title }> }>
// Returns { ok: true } or { ok: false, error: string, blocking: string[] }
export function checkCascadeRules(filename, newStatus, taskIndex) {
  if (newStatus !== 'Done') return { ok: true }
  const task = taskIndex.get(filename)
  if (!task) return { ok: true }
  const blocking = (task.children || [])
    .map(c => c.filename)
    .filter(f => {
      const child = taskIndex.get(f)
      return child != null && child.status !== 'Done'
    })
  if (blocking.length > 0) return { ok: false, error: 'children_not_done', blocking }
  return { ok: true }
}
