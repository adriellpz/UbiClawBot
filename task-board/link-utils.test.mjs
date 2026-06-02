import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseWikilink,
  formatWikilink,
  parseLinkList,
  formatLinkList,
  checkCascadeRules,
} from './link-utils.mjs'

// ── parseWikilink ─────────────────────────────────────────────────────────────

test('parseWikilink: alias form [[filename|Title]]', () => {
  assert.deepEqual(parseWikilink('[[foo|Bar Baz]]'), { filename: 'foo', title: 'Bar Baz' })
})

test('parseWikilink: no alias [[filename]]', () => {
  assert.deepEqual(parseWikilink('[[foo]]'), { filename: 'foo', title: 'foo' })
})

test('parseWikilink: filename with dashes', () => {
  assert.deepEqual(parseWikilink('[[my-task-123|My Task]]'), { filename: 'my-task-123', title: 'My Task' })
})

// ── formatWikilink ────────────────────────────────────────────────────────────

test('formatWikilink: produces [[filename|Title]]', () => {
  assert.equal(formatWikilink('foo', 'Bar Baz'), '[[foo|Bar Baz]]')
})

// ── parseLinkList ─────────────────────────────────────────────────────────────

test('parseLinkList: undefined → empty array', () => {
  assert.deepEqual(parseLinkList(undefined), [])
})

test('parseLinkList: null → empty array', () => {
  assert.deepEqual(parseLinkList(null), [])
})

test('parseLinkList: single string', () => {
  assert.deepEqual(parseLinkList('[[foo|Bar]]'), [{ filename: 'foo', title: 'Bar' }])
})

test('parseLinkList: array of strings', () => {
  assert.deepEqual(parseLinkList(['[[foo|Bar]]', '[[baz|Qux]]']), [
    { filename: 'foo', title: 'Bar' },
    { filename: 'baz', title: 'Qux' },
  ])
})

test('parseLinkList: skips unparseable entries', () => {
  assert.deepEqual(parseLinkList(['[[foo|Bar]]', '', 'not-a-link']), [
    { filename: 'foo', title: 'Bar' },
  ])
})

test('parseLinkList: skips empty wikilink [[]]', () => {
  assert.deepEqual(parseLinkList('[[]]'), [])
})

// ── formatLinkList ────────────────────────────────────────────────────────────

test('formatLinkList: converts objects to [[filename|Title]] strings', () => {
  assert.deepEqual(
    formatLinkList([{ filename: 'foo', title: 'Bar' }, { filename: 'baz', title: 'Qux' }]),
    ['[[foo|Bar]]', '[[baz|Qux]]'],
  )
})

test('formatLinkList: empty array → empty array', () => {
  assert.deepEqual(formatLinkList([]), [])
})

// ── checkCascadeRules ─────────────────────────────────────────────────────────

// taskIndex: Map<filename, { status, children, parent }>
// children values are already parsed link objects { filename, title }

test('checkCascadeRules: Done allowed when task has no children', () => {
  const index = new Map([
    ['task.md', { status: 'In Progress', children: [] }],
  ])
  const result = checkCascadeRules('task.md', 'Done', index)
  assert.equal(result.ok, true)
})

test('checkCascadeRules: Done blocked when a child is open', () => {
  const index = new Map([
    ['parent.md', { status: 'In Progress', children: [{ filename: 'child.md', title: 'Child' }] }],
    ['child.md', { status: 'In Progress', children: [] }],
  ])
  const result = checkCascadeRules('parent.md', 'Done', index)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'children_not_done')
  assert.deepEqual(result.blocking, ['child.md'])
})

test('checkCascadeRules: Done allowed when all children are Done', () => {
  const index = new Map([
    ['parent.md', { status: 'In Progress', children: [{ filename: 'child.md', title: 'Child' }] }],
    ['child.md', { status: 'Done', children: [] }],
  ])
  const result = checkCascadeRules('parent.md', 'Done', index)
  assert.equal(result.ok, true)
})

test('checkCascadeRules: Done allowed when children are absent from index (archived)', () => {
  const index = new Map([
    ['parent.md', { status: 'In Progress', children: [{ filename: 'archived.md', title: 'Old' }] }],
    // archived.md is NOT in the index
  ])
  const result = checkCascadeRules('parent.md', 'Done', index)
  assert.equal(result.ok, true)
})

test('checkCascadeRules: non-Done status always passes', () => {
  const index = new Map([
    ['parent.md', { status: 'Backlog', children: [{ filename: 'child.md', title: 'Child' }] }],
    ['child.md', { status: 'In Progress', children: [] }],
  ])
  const result = checkCascadeRules('parent.md', 'In Progress', index)
  assert.equal(result.ok, true)
})

test('checkCascadeRules: task not in index → ok (treat as no children)', () => {
  const index = new Map()
  const result = checkCascadeRules('unknown.md', 'Done', index)
  assert.equal(result.ok, true)
})
