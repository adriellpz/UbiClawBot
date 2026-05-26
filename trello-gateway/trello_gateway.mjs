#!/usr/bin/env node
/**
 * Trello Gateway Daemon
 * 
 * Runs as root (or separate user). Holds Trello credentials.
 * Agents connect via HTTP and request validated operations.
 * 
 * Security model:
 * - Gateway source is root-owned, chmod 700
 * - Agents NEVER see Trello API tokens
 * - Gateway validates EVERY operation against transition matrix
 * - All operations logged with agent ID and validation result
 * 
 * Setup:
 *   sudo cp trello_gateway.mjs /usr/local/bin/
 *   sudo chown root:root /usr/local/bin/trello_gateway.mjs
 *   sudo chmod 700 /usr/local/bin/trello_gateway.mjs
 *   sudo mkdir -p /etc/trello-gateway
 *   sudo tee /etc/trello-gateway/env << 'EOF'
 *   TRELLO_API_KEY=xxx
 *   TRELLO_API_TOKEN=xxx
 *   TRELLO_BOARD_ID=69f96aafc342ad1c89f48e0c
 *   GATEWAY_KEY=change-me-to-random-string
 *   PORT=18792
 *   EOF
 *   sudo chmod 600 /etc/trello-gateway/env
 *   sudo /usr/local/bin/trello_gateway.mjs
 */

import http from 'node:http';
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ─── Config ──────────────────────────────────────────────────────────
const ENV_FILE = process.env.GATEWAY_ENV_FILE || '/etc/trello-gateway/env';
function loadEnv(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnv(ENV_FILE);

const PORT = Number(process.env.PORT || 18792);
const GATEWAY_KEY = process.env.GATEWAY_KEY;
const TRELLO_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_API_TOKEN;
const BOARD_ID = process.env.TRELLO_BOARD_ID || '69f96aafc342ad1c89f48e0c';
const LOG_FILE = process.env.GATEWAY_LOG || '/var/log/trello-gateway.log';
const MOCK_MODE = process.env.MOCK_MODE === 'true';

// Per-agent Trello credentials for comment authorship (agentId → { key, token })
// Looks for TRELLO_API_KEY_<AGENT> + TRELLO_API_TOKEN_<AGENT> in env.
// Falls back to shared TRELLO_API_KEY + TRELLO_API_TOKEN.
const AGENT_CREDS = {};
for (const agent of ['marcos', 'main', 'scheduler', 'system']) {
  const key = process.env[`TRELLO_API_KEY_${agent.toUpperCase()}`];
  const token = process.env[`TRELLO_API_TOKEN_${agent.toUpperCase()}`];
  if (key && token) {
    AGENT_CREDS[agent] = { key, token };
  }
}

if (!GATEWAY_KEY) throw new Error('GATEWAY_KEY required');
if (!MOCK_MODE && (!TRELLO_KEY || !TRELLO_TOKEN)) throw new Error('Trello credentials required (or set MOCK_MODE=true)');

// ─── Transition Matrix ───────────────────────────────────────────────
const MATRIX_CSV = process.env.TRANSITION_MATRIX || resolve('/home/node/.openclaw/workspace-marcos/trello-refactor/trello_transition_matrix.csv');

function loadMatrix() {
  const lines = readFileSync(MATRIX_CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',');
  const transitions = new Map();
  const forbidden = new Set();
  
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const to = cols[0]?.trim();
    const from = cols[1]?.trim();
    const aiNeeded = cols[4]?.trim();
    const script = cols[6]?.trim();
    
    if (!to || !from) continue;
    
    const key = `${from}→${to}`;
    
    if (script === 'NO_SCRIPT' && aiNeeded === 'No') {
      forbidden.add(key);
    } else {
      transitions.set(key, { to, from, aiNeeded, script });
    }
  }
  
  return { transitions, forbidden };
}

const { transitions, forbidden } = loadMatrix();

// Per-agent token bucket rate limiters (prevent Trello API exhaustion)
const RATE_BUCKETS = {};

// ─── Agent Authorization ─────────────────────────────────────────────
const AGENT_RULES = {
  marcos: {
    allowedFrom: ['Blocked', 'Scheduled', 'Backlog', 'Done', 'Missed', 'Routine', 'Reschedule'],
    allowedTo: ['Blocked', 'Backlog', 'Done', 'Scheduled'],
    canComment: true,
    canArchive: false,
  },
  main: {  // ubi
    allowedFrom: ['*'],
    allowedTo: ['*'],
    canComment: true,
    canArchive: false,
  },
  scheduler: {  // cheryl
    allowedFrom: ['Scheduled', 'Reschedule', 'Routine'],
    allowedTo: ['Scheduled', 'Reschedule', 'Routine'],
    canComment: true,
    canArchive: false,
  },
  system: {  // automated scripts (reschedule, missed, done, drive-sync)
    allowedFrom: ['*'],
    allowedTo: ['*'],
    canComment: true,
    canArchive: false,
  },
};

// A2A sign-off enforcement — gateway appends if agent forgets
// Matches the rule in AGENTS.md (every agent workspace)
const SIGN_OFF_MAP = {
  marcos: '— Marcos (marcos)',
  main: '— Ubi (main)',
  scheduler: '— Cheryl (scheduler)',
  system: '— systemworker',
};

function isAuthorized(agentId, from, to) {
  const rules = AGENT_RULES[agentId];
  if (!rules) return { ok: false, reason: `Unknown agent: ${agentId}` };
  
  if (!rules.canArchive && to === 'Archived') {
    return { ok: false, reason: 'Agents cannot archive cards' };
  }
  
  const fromAllowed = rules.allowedFrom.includes('*') || rules.allowedFrom.includes(from);
  const toAllowed = rules.allowedTo.includes('*') || rules.allowedTo.includes(to);
  
  const allowedInfo = rules.allowedFrom.includes('*')
    ? 'any list'
    : `from [${rules.allowedFrom.join(', ')}] to [${rules.allowedTo.join(', ')}]`;
  
  if (!fromAllowed) return { ok: false, reason: `Agent ${agentId} cannot operate on ${from}. Allowed: ${allowedInfo}` };
  if (!toAllowed) return { ok: false, reason: `Agent ${agentId} cannot move to ${to}. Allowed: ${allowedInfo}` };
  
  return { ok: true };
}

// ─── Logging ─────────────────────────────────────────────────────────
let requestCounter = 0;
function log(event, requestId) {
  const entry = { ...event, ts: new Date().toISOString() };
  if (requestId) entry.requestId = requestId;
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    console.error(JSON.stringify(entry));
  }
}

// ─── Trello API ──────────────────────────────────────────────────────
async function trelloApi(method, path, params = {}, body = undefined, agentId) {
  if (MOCK_MODE) {
    // Mock responses for testing
    if (path.includes('/cards/')) {
      const cardId = path.split('/cards/')[1]?.split('?')[0] || 'test123';
      return { id: cardId, name: 'Test Card', idList: 'list_scheduled', closed: false, shortUrl: 'https://trello.com/c/test123' };
    }
    if (path.includes('/boards/') && path.includes('/lists')) {
      return [
        { id: 'list_backlog', name: 'Backlog', closed: false },
        { id: 'list_scheduled', name: 'Scheduled', closed: false },
        { id: 'list_focus', name: 'Adriel Focus', closed: false },
        { id: 'list_blocked', name: 'Blocked', closed: false },
        { id: 'list_done', name: 'Done', closed: false },
        { id: 'list_routine', name: 'Routine', closed: false },
        { id: 'list_reschedule', name: 'Reschedule', closed: false },
        { id: 'list_missed', name: 'Missed', closed: false },
      ];
    }
    return { success: true };
  }
  
  // Resolve credentials: per-agent override or shared defaults
  const creds = agentId && AGENT_CREDS[agentId];
  const key = creds ? creds.key : TRELLO_KEY;
  const token = creds ? creds.token : TRELLO_TOKEN;
  
  const url = new URL(`https://api.trello.com/1${path}`);
  url.searchParams.set('key', key);
  url.searchParams.set('token', token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`Trello API ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ─── Validation ──────────────────────────────────────────────────────
function allowedFrom(agentId, fromList) {
  const rules = AGENT_RULES[agentId];
  if (!rules) return [];
  if (rules.allowedFrom.includes('*')) return ['*'];
  if (!rules.allowedFrom.includes(fromList)) return [];
  return rules.allowedTo.includes('*') ? ['*'] : [...rules.allowedTo];
}

function formatAllowedHint(agentId, from, toLists) {
  if (toLists.length === 1 && toLists[0] === '*') return ` Allowed from ${from}: any non-forbidden list`;
  if (toLists.length === 0) return '';
  return ` Allowed from ${from}: [${toLists.join(', ')}]`;
}

function validateTransition(from, to, agentId, explicitFlags = []) {
  const key = `${from}→${to}`;
  
  // Check agent authorization
  const auth = isAuthorized(agentId, from, to);
  if (!auth.ok) return auth;
  
  // Check transition matrix
  if (forbidden.has(key)) {
    const allowed = allowedFrom(agentId, from).filter(t => t === '*' || !forbidden.has(`${from}→${t}`));
    return { ok: false, reason: `Transition ${key} is forbidden by matrix.${formatAllowedHint(agentId, from, allowed)}` };
  }
  
  const rule = transitions.get(key);
  if (!rule) {
    const allowed = allowedFrom(agentId, from).filter(t => t === '*' || transitions.has(`${from}→${t}`));
    return { ok: false, reason: `Transition ${key} not defined in matrix.${formatAllowedHint(agentId, from, allowed)}` };
  }
  
  // Adriel Focus is Adriel-only — no agent touches it
  if (from === 'Adriel Focus' || to === 'Adriel Focus') {
    return { ok: false, reason: 'Adriel Focus is Adriel-only — agents cannot touch this list' };
  }

  // Ubi places calendar time via Reschedule → handle_reschedule.mjs (system agent) → Scheduled
  if (agentId === 'main' && to === 'Scheduled') {
    return {
      ok: false,
      reason: 'Ubi cannot move directly to Scheduled. Comment, add Time needed: N in the card description if needed, and move to Reschedule; handle_reschedule.mjs will place the calendar block and move to Scheduled.',
    };
  }
  
  // Archived cards are read-only
  if (to === 'Archived') {
    return { ok: false, reason: 'Agents cannot archive cards' };
  }
  
  return { ok: true, rule };
}

function cardUrl(shortUrl) {
  if (!shortUrl) return undefined;
  if (shortUrl.startsWith('http')) return shortUrl;
  return `https://trello.com/c/${shortUrl}`;
}

// ─── HTTP Server ─────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const requestId = String(++requestCounter).padStart(8, '0');
  res.setHeader('content-type', 'application/json');
  res.setHeader('x-request-id', requestId);
  
  // Auth check
  const authHeader = req.headers['authorization'] || '';
  const providedKey = authHeader.replace(/^Bearer\s+/i, '');
  if (providedKey !== GATEWAY_KEY) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Invalid gateway key' }));
    log({ event: 'auth_fail', ip: req.socket.remoteAddress }, requestId);
    return;
  }
  
  // Parse body
  let body = '';
  for await (const chunk of req) body += chunk;
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }
  
  const { agentId, operation, cardId, params = {} } = data;
  
  if (!agentId || !operation) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Missing agentId or operation' }));
    return;
  }
  
  log({ event: 'request', agentId, operation, cardId, params }, requestId);
  
  // Rate limiting (token bucket per agent, prevents Trello API exhaustion)
  const RATE_LIMITS = {
    marcos: { maxTokens: 20, refillPerSec: 1 },
    main: { maxTokens: 40, refillPerSec: 2 },
    scheduler: { maxTokens: 30, refillPerSec: 1.5 },
    system: { maxTokens: 30, refillPerSec: 1.5 },
  };
  if (!RATE_BUCKETS[agentId]) {
    RATE_BUCKETS[agentId] = { tokens: RATE_LIMITS[agentId]?.maxTokens ?? 10, lastRefill: Date.now() };
  }
  const bucket = RATE_BUCKETS[agentId];
  const limit = RATE_LIMITS[agentId] || { maxTokens: 10, refillPerSec: 1 };
  const nowMs = Date.now();
  const elapsed = (nowMs - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(limit.maxTokens, bucket.tokens + elapsed * limit.refillPerSec);
  bucket.lastRefill = nowMs;
  if (bucket.tokens < 1) {
    res.writeHead(429);
    res.end(JSON.stringify({ error: `Rate limited. Agent ${agentId} exceeded ${limit.maxTokens} requests per burst. Retry after ${Math.ceil((1 - bucket.tokens) / limit.refillPerSec)}s.` }));
    log({ event: 'rate_limited', agentId }, requestId);
    return;
  }
  bucket.tokens -= 1;
  
  // Read operations don't need cardId validation upfront
  const isReadOp = ['get', 'list', 'search', 'comments', 'board_lists', 'board_custom_fields', 'status'].includes(operation);
  const isLabelOp = ['get_labels', 'create_label', 'update_label'].includes(operation);
  
  let card = null;
  let currentList = null;
  
  if (!isReadOp && !isLabelOp && cardId) {
    // Fetch card info for write operations
    try {
      card = await trelloApi('GET', `/cards/${cardId}`, { fields: 'name,idList,closed,shortUrl' });
    } catch (e) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'Failed to fetch card', details: e.message }));
      log({ event: 'trello_error', agentId, operation, cardId, error: e.message }, requestId);
      return;
    }
    
    if (card.closed) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Card is archived/closed', card: card.name }));
      log({ event: 'blocked_archived', agentId, operation, cardId, card: card.name }, requestId);
      return;
    }
    
    // Get current list name
    try {
      const lists = await trelloApi('GET', `/boards/${BOARD_ID}/lists`, { fields: 'name' });
      currentList = lists.find(l => l.id === card.idList)?.name || 'Unknown';
    } catch {}
  }
  
  // Execute operation
  let result;
  try {
    switch (operation) {
      case 'create_card': {
        const listName = params.listName || 'Backlog';
        const cardName = params.name;
        if (!cardName) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing name parameter' }));
          return;
        }
        // Resolve list
        const allLists = await trelloApi('GET', `/boards/${BOARD_ID}/lists`, { fields: 'name,closed' });
        const targetList = allLists.find(l => !l.closed && l.name.toLowerCase() === listName.toLowerCase());
        if (!targetList) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `List not found: ${listName}` }));
          return;
        }
        // Block creation in Adriel Focus
        if (targetList.name === 'Adriel Focus') {
          res.writeHead(403);
          res.end(JSON.stringify({ blocked: true, reason: 'Adriel Focus is Adriel-only — agents cannot create cards there' }));
          log({ event: 'blocked_create_adriel_focus', agentId, list: targetList.name }, requestId);
          return;
        }
        if (agentId === 'main' && targetList.name === 'Scheduled') {
          res.writeHead(403);
          res.end(JSON.stringify({
            blocked: true,
            reason: 'Ubi cannot create cards directly in Scheduled. Create in Backlog (or Routine), then move to Reschedule for calendar placement.',
          }));
          log({ event: 'blocked_create_scheduled', agentId, list: targetList.name }, requestId);
          return;
        }
        // Build payload
        const createBody = { idList: targetList.id, name: cardName };
        if (params.desc) createBody.desc = params.desc;
        if (params.due) createBody.due = params.due;
        if (params.pos) createBody.pos = params.pos;
        const newCard = await trelloApi('POST', '/cards', createBody, undefined, agentId);
        result = { created: true, cardId: newCard.id, cardName: newCard.name, list: targetList.name, url: cardUrl(newCard.shortUrl) };
        log({ event: 'card_created', agentId, cardId: newCard.id, cardName: newCard.name, list: targetList.name }, requestId);
        break;
      }

      case 'board_lists': {
        const lists = await trelloApi('GET', `/boards/${BOARD_ID}/lists`, { fields: 'name,closed' });
        result = { lists: lists.filter(l => !l.closed) };
        break;
      }

      case 'board_custom_fields': {
        const fields = await trelloApi('GET', `/boards/${BOARD_ID}/customFields`);
        result = { fields: fields || [] };
        break;
      }

      case 'status': {
        result = {
          status: 'ok',
          port: PORT,
          boardId: BOARD_ID,
          transitions: transitions.size,
          forbidden: forbidden.size,
          agents: Object.keys(AGENT_CREDS),
        };
        break;
      }
      
      case 'list': {
        const listName = params.listName;
        if (!listName) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing listName parameter' }));
          return;
        }
        
        const lists = await trelloApi('GET', `/boards/${BOARD_ID}/lists`, { fields: 'name,closed' });
        const targetList = lists.find(l => !l.closed && l.name.toLowerCase() === listName.toLowerCase());
        if (!targetList) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `List not found: ${listName}` }));
          return;
        }
        
        const cards = await trelloApi('GET', `/lists/${targetList.id}/cards`, { fields: 'name,id,due,labels,shortUrl,desc' });
        result = { list: targetList.name, cards };
        break;
      }
      
      case 'search': {
        const query = params.query;
        if (!query) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing query parameter' }));
          return;
        }
        
        const searchResult = await trelloApi('GET', '/search', { 
          query, 
          modelTypes: 'cards',
          card_fields: 'name,id,due,labels,shortUrl,desc,idList',
          cards_limit: 50 
        });
        result = { cards: searchResult.cards || [] };
        break;
      }
      
      case 'comments': {
        if (!cardId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing cardId for comments operation' }));
          return;
        }
        
        const actions = await trelloApi('GET', `/cards/${cardId}/actions`, { 
          filter: 'commentCard',
          fields: 'data,date,memberCreator'
        });
        result = { comments: actions || [] };
        break;
      }
      
      case 'move': {
        const targetList = params.targetList;
        if (!targetList) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing targetList parameter' }));
          return;
        }
        
        // Resolve list name to ID
        const lists = await trelloApi('GET', `/boards/${BOARD_ID}/lists`, { fields: 'name,closed' });
        const target = lists.find(l => !l.closed && (l.id === targetList || l.name.toLowerCase() === targetList.toLowerCase()));
        if (!target) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `List not found: ${targetList}` }));
          return;
        }
        
        // Validate transition
        const validation = validateTransition(currentList, target.name, agentId, params.explicitFlags || []);
        if (!validation.ok) {
          res.writeHead(403);
          res.end(JSON.stringify({ blocked: true, reason: validation.reason, from: currentList, to: target.name }));
          log({ event: 'blocked_transition', agentId, cardId, from: currentList, to: target.name, reason: validation.reason }, requestId);
          return;
        }
        
        // Execute
        const updateBody = { idList: target.id };
        if (params.due) updateBody.due = params.due;
        await trelloApi('PUT', `/cards/${cardId}`, updateBody, undefined, agentId);
        result = { moved: true, from: currentList, to: target.name, card: card.name };
        if (params.due) result.due = params.due;
        break;
      }
      
      case 'comment': {
        let text = params.text;
        if (!text) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing text parameter' }));
          return;
        }
        
        const rules = AGENT_RULES[agentId];
        if (!rules?.canComment) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Agent cannot comment' }));
          return;
        }
        
        // Enforce A2A sign-off
        const expectedSignOff = SIGN_OFF_MAP[agentId];
        if (expectedSignOff) {
          const trimmed = text.trimEnd();
          if (!trimmed.endsWith(expectedSignOff)) {
            text = trimmed + '\n\n' + expectedSignOff;
            log({ event: 'sign-off_appended', agentId, cardId }, requestId);
          }
        }
        
        // Use agent-specific Trello credentials so comment author matches the agent
        await trelloApi('POST', `/cards/${cardId}/actions/comments`, { text }, undefined, agentId);
        result = { commented: true, card: card.name };
        break;
      }
      
      case 'get': {
        const fields = params.fields || 'name,idList,closed,shortUrl,desc,due,start,cover,labels,idMembers';
        const cardData = await trelloApi('GET', `/cards/${cardId || params.cardId}`, { fields, customFieldItems: true });
        // Augment with list name if list is present
        if (cardData && cardData.idList) {
          try {
            const lists = await trelloApi('GET', `/boards/${BOARD_ID}/lists`, { fields: 'name' });
            cardData.list = lists.find(l => l.id === cardData.idList) || null;
          } catch {}
        }
        result = { card: cardData };
        // Attach custom field definitions so agents can map IDs to names
        if (cardData) {
          try {
            const cfDefs = await trelloApi('GET', `/boards/${BOARD_ID}/customFields`);
            if (cfDefs && cfDefs.length > 0) cardData.customFieldDefs = cfDefs;
          } catch {}
        }
        break;
      }

      case 'update': {
        const fields = params.fields || {};
        if (!fields || Object.keys(fields).length === 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing fields to update' }));
          return;
        }
        await trelloApi('PUT', `/cards/${cardId}`, fields, undefined, agentId);
        result = { updated: true, card: card.name, fields };
        break;
      }

      case 'get_labels': {
        const labels = await trelloApi('GET', `/boards/${BOARD_ID}/labels`, { fields: 'id,name,color' });
        result = { labels: labels || [] };
        break;
      }

      case 'create_label': {
        const { color, name } = params;
        if (!color || !name) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing color or name for label' }));
          return;
        }
        const label = await trelloApi('POST', '/labels', { idBoard: BOARD_ID, color, name }, undefined, agentId);
        result = { label };
        break;
      }

      case 'update_label': {
        const labelId = params.labelId || cardId;
        if (!labelId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing labelId' }));
          return;
        }
        const labelFields = {};
        if (params.name) labelFields.name = params.name;
        if (params.color) labelFields.color = params.color;
        const label = await trelloApi('PUT', `/labels/${labelId}`, labelFields, undefined, agentId);
        result = { label };
        break;
      }

      case 'set_cover': {
        const color = params.color;
        if (!color) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing color parameter' }));
          return;
        }
        if (card.closed) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Card is archived/closed', card: card.name }));
          return;
        }
        await trelloApi('PUT', `/cards/${cardId}/cover`, {}, { value: { idAttachment: null, color, idUploadedBackground: null, size: 'normal', brightness: 'light' } }, agentId);
        result = { cover: color, card: card.name };
        break;
      }

      case 'set_custom_field': {
        const fieldId = params.fieldId;
        if (!fieldId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing fieldId parameter' }));
          return;
        }
        if (params.value === undefined || params.value === null) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing value parameter' }));
          return;
        }
        let val;
        if (typeof params.value === 'number' || typeof params.value === 'string') {
          const num = Number(params.value);
          val = Number.isFinite(num) ? { number: String(num) } : { text: String(params.value) };
        } else {
          val = params.value;
        }
        await trelloApi('PUT', `/cards/${cardId}/customField/${fieldId}/item`, {}, { value: val }, agentId);
        result = { updated: true, fieldId, value: val };
        break;
      }

      case 'add_label': {
        const labelId = params.labelId;
        if (!labelId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing labelId parameter' }));
          return;
        }
        if (card.closed) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Card is archived/closed', card: card.name }));
          return;
        }
        await trelloApi('POST', `/cards/${cardId}/idLabels`, { value: labelId }, undefined, agentId);
        result = { labelAdded: labelId, card: card.name };
        break;
      }

      case 'remove_label': {
        const labelId = params.labelId;
        if (!labelId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing labelId parameter' }));
          return;
        }
        if (card.closed) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Card is archived/closed', card: card.name }));
          return;
        }
        await trelloApi('DELETE', `/cards/${cardId}/idLabels/${labelId}`, {}, undefined, agentId);
        result = { labelRemoved: labelId, card: card.name };
        break;
      }

      case 'add_member': {
        const memberId = params.memberId;
        if (!memberId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing memberId parameter' }));
          return;
        }
        if (card.closed) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Card is archived/closed', card: card.name }));
          return;
        }
        await trelloApi('POST', `/cards/${cardId}/idMembers`, { value: memberId }, undefined, agentId);
        result = { memberAdded: memberId, card: card.name };
        break;
      }

      case 'remove_member': {
        const memberId = params.memberId;
        if (!memberId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing memberId parameter' }));
          return;
        }
        if (card.closed) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Card is archived/closed', card: card.name }));
          return;
        }
        await trelloApi('DELETE', `/cards/${cardId}/idMembers/${memberId}`, {}, undefined, agentId);
        result = { memberRemoved: memberId, card: card.name };
        break;
      }
      
      default:
        res.writeHead(400);
        res.end(JSON.stringify({ error: `Unknown operation: ${operation}` }));
        return;
    }
    
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, ...result }));
    log({ event: 'success', agentId, operation, cardId, result }, requestId);
    
  } catch (e) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'Operation failed', details: e.message }));
    log({ event: 'error', agentId, operation, cardId, error: e.message }, requestId);
  }
}

// ─── Background Overdue Card Detection (deterministic, no AI) ────────

const OVERDUE_STATE_DIR = join(resolve('/home/node/.openclaw/workspace/trello_bridge/state'));
const OVERDUE_TRACKED_FILE = join(OVERDUE_STATE_DIR, 'overdue_tracked.json');

function readOverdueTracked() {
  try {
    if (existsSync(OVERDUE_TRACKED_FILE))
      return JSON.parse(readFileSync(OVERDUE_TRACKED_FILE, 'utf8'));
  } catch {}
  return { flagged: {} };
}

function writeOverdueTracked(state) {
  try {
    if (!existsSync(OVERDUE_STATE_DIR))
      mkdirSync(OVERDUE_STATE_DIR, { recursive: true });
    writeFileSync(OVERDUE_TRACKED_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log({ event: 'overdue_state_write_error', error: e.message });
  }
}

async function checkOverdueCards() {
  try {
    const now = new Date();
    const state = readOverdueTracked();
    const tracked = state.flagged;

    // Get Scheduled list id
    const lists = await trelloApi('GET', `/boards/${BOARD_ID}/lists`, { fields: 'name' });
    const scheduledList = lists.find(l => l.name === 'Scheduled');
    if (!scheduledList) return;

    // Get cards in Scheduled with minimal fields
    const cards = await trelloApi('GET', `/lists/${scheduledList.id}/cards`, {
      fields: 'name,due,shortUrl',
    });

    const currentIds = new Set();
    let flagged = 0;

    for (const card of cards) {
      currentIds.add(card.id);
      const due = card.due ? new Date(card.due) : null;

      if (!due || due > now) {
        tracked[card.id] = '__skip__';
        continue;
      }

      // Flag by commenting — every 15-min pass, no dedup
      // Adriel wants constant reminders until the card leaves Scheduled.
      const pastDueMin = Math.round((now - due) / 60000);
      const timeStr = due.toLocaleString('en-US', {
        timeZone: 'America/Denver',
        hour: 'numeric', minute: '2-digit',
        month: 'short', day: 'numeric',
      });

      await trelloApi('POST', `/cards/${card.id}/actions/comments`, {}, {
        text: `⏰ Calendar block ended ${timeStr} (${pastDueMin}m ago) and this card is still in Scheduled. Is it done, still in progress, or should be marked Missed/Rescheduled? @adriellopez1`,
      }, 'system');

      // Remove from tracked so it re-flags next pass (we only keep it to
      // avoid re-flagging cards whose block hasn't ended yet).
      delete tracked[card.id];
      flagged++;
    }

    // Cleanup stale tracked IDs
    for (const id of Object.keys(tracked)) {
      if (!currentIds.has(id)) delete tracked[id];
    }

    writeOverdueTracked(state);
    if (flagged > 0) {
      log({ event: 'overdue_flagged', count: flagged });
    }
  } catch (e) {
    // Log but don't crash the gateway
    log({ event: 'overdue_check_error', error: e.message });
  }
}

function startOverdueCheck() {
  // First check after 60s (let gateway boot fully), then every 15 minutes
  setTimeout(() => {
    checkOverdueCards();
    setInterval(() => {
      checkOverdueCards();
    }, 15 * 60 * 1000);
  }, 60_000);
  console.log('Overdue card detection active (every 15 min, starting in 60s)');
}

const BIND = process.env.BIND || '0.0.0.0';

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/healthz/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: PORT }));
    return;
  }
  return handleRequest(req, res);
});
server.listen(PORT, BIND, () => {
  console.log(`Trello Gateway listening on http://${BIND}:${PORT}`);
  console.log(`Loaded ${transitions.size} allowed transitions, ${forbidden.size} forbidden`);
  log({ event: 'startup', port: PORT, transitions: transitions.size, forbidden: forbidden.size });
  
  // Start overdue-check background timer (runs as the gateway — no external cron needed)
  startOverdueCheck();
});
