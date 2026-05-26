const GATEWAY_URL = process.env.TRELLO_GATEWAY_URL;
const GATEWAY_KEY = process.env.TRELLO_GATEWAY_KEY || process.env.GATEWAY_KEY;

async function gw(operation, cardId, params = {}, agentId) {
  if (!GATEWAY_URL) throw new Error("TRELLO_GATEWAY_URL is required for non-dry-run execution.");
  if (!GATEWAY_KEY) throw new Error("TRELLO_GATEWAY_KEY is required for non-dry-run execution.");
  if (!agentId) throw new Error("gateway operation requires agentId");

  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ agentId, operation, cardId, params }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(text || `Gateway ${operation} failed`);
  return text ? JSON.parse(text) : {};
}

export async function createCard(name, opts = {}, agentId) {
  return gw(
    "create_card",
    null,
    {
      name,
      listName: opts.listName || "Backlog",
      desc: opts.desc,
      due: opts.due,
      checklists: opts.checklists,
    },
    agentId,
  );
}

export async function getCard(cardId, agentId) {
  const data = await gw("get", cardId, {}, agentId);
  return data.card || null;
}

export async function updateCard(cardId, fields, agentId) {
  return gw("update", cardId, { fields }, agentId);
}

export async function comment(cardId, text, agentId) {
  return gw("comment", cardId, { text }, agentId);
}

export async function moveCard(cardId, targetListName, due, agentId) {
  const params = { targetList: targetListName };
  if (due) params.due = due;
  return gw("move", cardId, params, agentId);
}

export async function getLists(agentId) {
  const data = await gw("board_lists", "board", {}, agentId);
  return data.lists || [];
}

export async function boardOpenCards(agentId) {
  const data = await gw("board_open_cards", "board", {}, agentId);
  return data.cards || [];
}

function norm(value) {
  return String(value || "").toLowerCase();
}

function stripPriorityPrefix(name) {
  return String(name || "").replace(/^P[123]\s*-\s*/i, "").trim();
}

function coverColor(card) {
  const title = norm(stripPriorityPrefix(card.name));
  const desc = norm(card.desc || "");
  if (/not needed|cancelled|canceled/.test(title)) return "purple";
  if (/\b(date|wife|therapy)\b|fire on the mountain|highlands market|farmers market|colorado clays|shooting park/.test(title)) return "pink";
  if (/dog walk|sciatica|planet fitness|workout|swim|swimming/.test(title)) return "green";
  if (/qa|job|application|reveal|termgrid|versapay|browserbase|resume/.test(title)) return "yellow";
  if (/sp tech|client|web client|github repo|services\/pricing/.test(title)) return "sky";
  if (/ot|hours|credit|xfinity|admin|timesheet|money|backup|meal prep|ollo|activate.*card|card activation/.test(title)) return "orange";
  if (/toilet|drive time|room|clean|home|arlo|kali|sand|litter|paperwork|desk/.test(title)) return "blue";
  if (/token|api|access|approval|configure|blocked/.test(title)) return "red";
  if (/research|rule|webhook|trello|agent|openclaw|ubi|plex/.test(title)) return "purple";
  if (/needs adriel|requires adriel|blocked by|api access|token/.test(desc)) return "red";
  return "purple";
}

function isUbiOwned(card) {
  const value = `${stripPriorityPrefix(card.name)}\n${card.desc || ""}`.toLowerCase();
  return /ubi-only|no adriel calendar event needed|no calendar event needed|research summary|workflow doc|workflow\/cheryl|audit script|implemented\/persisted|restart readiness|evaluate hello epics|explain evening gap|nightly scheduled resolver|scheduled nightly resolution|reciprocal lock|cron isolated finalization|trello intake agent cron|cron skip-if-active|cron skip if active/.test(
    value,
  );
}

function needsAdriel(card, listName) {
  if (listName === "Scheduled") return true;
  const value = `${stripPriorityPrefix(card.name)}\n${card.desc || ""}`.toLowerCase();
  return /adriel|needs .*approval|ticket|pay |upload|review|clean|toilet|charge|dog walk|sciatica|planet fitness|xfinity|tax deductions|timesheet|hours|therapy|transcripts/.test(
    value,
  );
}

function desiredMembers(card, listName) {
  if (listName === "Missed") return null;
  if (listName === "Done") return isUbiOwned(card) ? [process.env.TRELLO_UBI_MEMBER_ID || "69f9d4b24b7f58666dad1680"] : null;
  if (listName === "Scheduled") {
    return isUbiOwned(card)
      ? [process.env.TRELLO_UBI_MEMBER_ID || "69f9d4b24b7f58666dad1680"]
      : [process.env.TRELLO_ADRIEL_MEMBER_ID || "69f96a7eeee0ace76d8f7639"];
  }
  if (isUbiOwned(card)) return [process.env.TRELLO_UBI_MEMBER_ID || "69f9d4b24b7f58666dad1680"];
  if (needsAdriel(card, listName)) return [process.env.TRELLO_ADRIEL_MEMBER_ID || "69f96a7eeee0ace76d8f7639"];
  return [];
}

export async function styleCard(cardId, agentId) {
  const card = await getCard(cardId, agentId);
  if (!card) throw new Error(`Card not found: ${cardId}`);
  if (card.closed) return { id: card.id, name: card.name, skipped: true, reason: "card_is_closed_archived" };

  await gw("set_cover", card.id, { color: coverColor(card) }, agentId);

  const labelsData = await gw("get_labels", "board", {}, agentId);
  const labels = labelsData.labels || [];
  const currentPriority = (card.labels || []).find((label) => /^Priority: /i.test(label.name || ""));

  let priorityName = "Priority: Low";
  const searchable = norm(`${card.name}\n${card.desc || ""}`);
  if (/not needed|cancelled|canceled/.test(searchable)) priorityName = "Priority: Low";
  else if (
    card.list?.name === "Due Today" ||
    /priority: high|high priority|urgent|today|tonight|as soon as possible|asap|ticket|fine|court|deadline|needs adriel|access|token|api|blocked/.test(
      searchable,
    )
  ) {
    priorityName = "Priority: High";
  } else if (/\b(ot block|ot makeup|overtime|dog walk|sciatica|swim|planet fitness|workout|sunday reset)\b/.test(searchable)) {
    priorityName = "Priority: High";
  } else if (/priority: medium|review|follow-up|research|next step|draft|setup|configure|ollo|activate.*card|card activation/.test(searchable)) {
    priorityName = "Priority: Medium";
  }

  const priorityLabel = labels.find((label) => label.name === priorityName);
  if (priorityLabel && (!currentPriority || currentPriority.id !== priorityLabel.id)) {
    if (currentPriority) await gw("remove_label", card.id, { labelId: currentPriority.id }, agentId);
    await gw("add_label", card.id, { labelId: priorityLabel.id }, agentId);
  }

  const listName = card.list?.name || "";
  const targetMembers = desiredMembers(card, listName);
  if (targetMembers !== null) {
    const currentMembers = new Set(card.idMembers || []);
    const desired = new Set(targetMembers);
    for (const memberId of desired) {
      if (!currentMembers.has(memberId)) await gw("add_member", card.id, { memberId }, agentId);
    }
    for (const memberId of currentMembers) {
      if (
        (memberId === (process.env.TRELLO_ADRIEL_MEMBER_ID || "69f96a7eeee0ace76d8f7639") ||
          memberId === (process.env.TRELLO_UBI_MEMBER_ID || "69f9d4b24b7f58666dad1680")) &&
        !desired.has(memberId)
      ) {
        await gw("remove_member", card.id, { memberId }, agentId);
      }
    }
  }

  return { id: card.id, name: card.name, listName };
}
