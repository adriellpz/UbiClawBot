export const REQUIRED_SECTION_ORDER = [
  "Original Request",
  "Research",
  "Peer Review",
  "Work completed",
];

export const NEXT_STEPS_CHECKLIST_NAME = "Next steps";
export const DEFAULT_CONTRACT_SCOPED_LISTS = new Set([
  "Backlog",
  "Scheduled",
  "Blocked",
  "Routine",
  "Reschedule",
  "Missed",
  "Adriel Focus",
]);
export const DEFAULT_DONE_LIST_NAMES = new Set(["Done"]);
const WORK_COMPLETED_LINE_RE = /^\d{4}-\d{2}-\d{2} MDT - .+$/;
const WORK_COMPLETED_PREFIX = /^\d{4}-\d{2}-\d{2} MDT - /;
const MAX_WORK_COMPLETED_PAYLOAD = 120;
const UPDATE_STRUCTURAL_FIELDS = new Set(["desc", "idList", "closed"]);

function normalizeChecklistNames(checklists = []) {
  return checklists
    .map((checklist) => {
      if (typeof checklist === "string") return checklist;
      return checklist?.name;
    })
    .filter((name) => typeof name === "string")
    .map((name) => name.trim());
}

function splitLines(text) {
  if (!text || text.trim() === "") return [];
  return text.split("\n").map((line) => line.trimEnd());
}

function normalizeTextForEquality(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function levenshteinDistance(a, b) {
  const left = normalizeTextForEquality(a);
  const right = normalizeTextForEquality(b);
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let col = 1; col <= right.length; col += 1) {
      const current = previous[col];
      previous[col] = Math.min(
        previous[col] + 1,
        previous[col - 1] + 1,
        diagonal + (left[row - 1] === right[col - 1] ? 0 : 1),
      );
      diagonal = current;
    }
  }

  return previous[right.length];
}

function isTypoCleanup(previousText, nextText) {
  const before = normalizeTextForEquality(previousText);
  const after = normalizeTextForEquality(nextText);
  if (before === after) return true;
  if (!before || !after) return false;

  const beforeWords = before.split(" ");
  const afterWords = after.split(" ");
  if (beforeWords.length !== afterWords.length) return false;

  const distance = levenshteinDistance(before, after);
  return distance <= Math.max(2, Math.ceil(before.length * 0.08));
}

function compareSection(sectionName, currentSections, nextSections) {
  return {
    previous: currentSections?.[sectionName] ?? "",
    next: nextSections?.[sectionName] ?? "",
  };
}

function validateSectionMutations({ agentId, currentSections, nextSections }) {
  const originalRequest = compareSection("Original Request", currentSections, nextSections);
  if (!isTypoCleanup(originalRequest.previous, originalRequest.next)) {
    return {
      ok: false,
      reason: "`Original Request` is immutable except for typo cleanup",
      code: "original_request_immutable",
    };
  }

  const peerReview = compareSection("Peer Review", currentSections, nextSections);
  const previousPeerReview = normalizeTextForEquality(peerReview.previous);
  const nextPeerReview = normalizeTextForEquality(peerReview.next);
  if (previousPeerReview !== nextPeerReview && (previousPeerReview || nextPeerReview) && agentId !== "marcos") {
    return {
      ok: false,
      reason: "Only Marcos may add or change non-blank `Peer Review` content",
      code: "peer_review_locked",
    };
  }

  const workCompleted = compareSection("Work completed", currentSections, nextSections);
  const previousLines = splitLines(workCompleted.previous);
  const nextLines = splitLines(workCompleted.next);
  if (nextLines.length < previousLines.length) {
    return {
      ok: false,
      reason: "`Work completed` is append-only",
      code: "work_completed_append_only",
    };
  }
  for (let index = 0; index < previousLines.length; index += 1) {
    if (previousLines[index] !== nextLines[index]) {
      return {
        ok: false,
        reason: "`Work completed` entries may only be appended",
        code: "work_completed_append_only",
      };
    }
  }

  return { ok: true };
}

export function isContractScopedList(
  listName,
  { scopedListNames = DEFAULT_CONTRACT_SCOPED_LISTS, doneListNames = DEFAULT_DONE_LIST_NAMES } = {},
) {
  if (!listName) return false;
  return scopedListNames.has(listName) && !doneListNames.has(listName);
}

export function classifyContractOperation({ operation, params = {} }) {
  switch (operation) {
    case "comment":
    case "set_cover":
    case "set_custom_field":
    case "add_label":
    case "remove_label":
    case "add_member":
    case "remove_member":
    case "create_checklist_item":
    case "update_checklist_item":
    case "delete_checklist_item":
      return { mode: "non_structural", operation };
    case "update": {
      const fields = params.fields || {};
      const touchesStructure = Object.keys(fields).some((field) => UPDATE_STRUCTURAL_FIELDS.has(field));
      return {
        mode: touchesStructure ? "structural" : "non_structural",
        operation,
        touchedFields: Object.keys(fields),
      };
    }
    case "create_card":
    case "move":
    case "create_checklist":
    case "update_checklist":
    // Future invariant: block delete_checklist when it would remove the sole native Next steps checklist.
    case "delete_checklist":
      return { mode: "structural", operation };
    default:
      return { mode: "unknown", operation };
  }
}

function hasNextStepsChecklist(snapshot) {
  const checklistNames = normalizeChecklistNames(snapshot?.checklists);
  return checklistNames.filter((name) => name === NEXT_STEPS_CHECKLIST_NAME).length === 1;
}

/**
 * Merge planned structural effects into `next` before validation.
 * Trello writes checklists after the card shell exists; callers may forget to
 * fold request params into the planned snapshot (especially create_checklist).
 */
export function projectContractNextSnapshot({ classification, params = {}, current, next }) {
  if (!next) return next;

  const operation = classification?.operation;
  if (operation === "create_checklist") {
    const checklistName = typeof params.name === "string" ? params.name.trim() : "";
    if (!checklistName) return next;
    const baseChecklists = Array.isArray(next.checklists) ? [...next.checklists] : [];
    const names = normalizeChecklistNames(baseChecklists);
    if (names.includes(checklistName)) return next;
    return { ...next, checklists: [...baseChecklists, { name: checklistName }] };
  }

  if (operation === "update_checklist") {
    const checklistId = params.checklistId;
    const checklistName = typeof params.name === "string" ? params.name.trim() : "";
    if (!checklistId || !checklistName) return next;
    const baseChecklists = Array.isArray(next.checklists) ? next.checklists : [];
    return {
      ...next,
      checklists: baseChecklists.map((checklist) =>
        checklist?.id === checklistId ? { ...checklist, name: checklistName } : checklist,
      ),
    };
  }

  if (operation === "create_card" && !current) {
    const rawChecklists = params.checklists;
    if (!Array.isArray(rawChecklists) || rawChecklists.length === 0) return next;
    const baseChecklists = Array.isArray(next.checklists) ? [...next.checklists] : [];
    for (const entry of rawChecklists) {
      const name = typeof entry === "string" ? entry.trim() : typeof entry?.name === "string" ? entry.name.trim() : "";
      if (!name) continue;
      const names = normalizeChecklistNames(baseChecklists);
      if (!names.includes(name)) baseChecklists.push({ name });
    }
    return { ...next, checklists: baseChecklists };
  }

  return next;
}

function isRepairStep({ classification, current, next }) {
  const op = classification?.operation;
  if (!current || !next) return false;

  if (op === "create_checklist" || op === "update_checklist") {
    return !hasNextStepsChecklist(current) && hasNextStepsChecklist(next);
  }

  if (op === "update") {
    const touchedFields = new Set(classification?.touchedFields || []);
    const descOnlyRepair = touchedFields.size === 1 && touchedFields.has("desc");
    if (!descOnlyRepair) return false;
    if ((current?.desc || "") === (next?.desc || "")) return false;
    // Repair must land on a contract-shaped body; partial or legacy desc shapes stay blocked
    // until the agent writes all required sections (checklist may still be missing on this step).
    return parseContractDescription(next?.desc || "").ok;
  }

  return false;
}

export function parseContractDescription(desc) {
  const text = typeof desc === "string" ? desc.replace(/\r\n/g, "\n") : "";
  if (/^Next steps:\s*$/m.test(text)) {
    return {
      ok: false,
      reason: "`Next steps` must be a native checklist, not a description section",
      code: "next_steps_must_be_checklist",
    };
  }
  const headerRe = /^(Original Request|Research|Peer Review|Work completed):\s*$/gm;
  const matches = Array.from(text.matchAll(headerRe));

  if (matches.length !== REQUIRED_SECTION_ORDER.length) {
    return {
      ok: false,
      reason: "Description must contain exactly the required sections in order",
      code: "invalid_sections",
    };
  }

  const sectionNames = matches.map((match) => match[1]);
  if (sectionNames.join("|") !== REQUIRED_SECTION_ORDER.join("|")) {
    return {
      ok: false,
      reason: "Description sections are missing or out of order",
      code: "invalid_section_order",
    };
  }

  const sections = {};
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const name = match[1];
    const contentStart = match.index + match[0].length;
    const contentEnd = index + 1 < matches.length ? matches[index + 1].index : text.length;
    sections[name] = text.slice(contentStart, contentEnd).replace(/^\n/, "").trimEnd();
  }

  return { ok: true, sections };
}

export function validateCardSnapshot({ desc, checklists = [] }, options = {}) {
  const { requireBlankPeerReview = false } = options;
  const parsed = parseContractDescription(desc);
  if (!parsed.ok) return parsed;

  const checklistNames = normalizeChecklistNames(checklists);
  const nextStepsChecklistCount = checklistNames.filter((name) => name === NEXT_STEPS_CHECKLIST_NAME).length;

  if (nextStepsChecklistCount !== 1) {
    return {
      ok: false,
      reason: "Card must include a native `Next steps` checklist",
      code: "missing_next_steps_checklist",
    };
  }

  const workCompleted = parsed.sections["Work completed"];
  if (workCompleted.trim() !== "") {
    for (const line of workCompleted.split("\n")) {
      if (!WORK_COMPLETED_LINE_RE.test(line)) {
        return {
          ok: false,
          reason: "Work completed entries must be dated MDT milestone lines",
          code: "invalid_work_completed_line",
        };
      }

      const payload = line.replace(WORK_COMPLETED_PREFIX, "");
      if (payload.length > MAX_WORK_COMPLETED_PAYLOAD) {
        return {
          ok: false,
          reason: "Work completed entries must stay within the per-line payload limit",
          code: "work_completed_line_too_long",
        };
      }
    }
  }

  if (requireBlankPeerReview && parsed.sections["Peer Review"].trim() !== "") {
    return {
      ok: false,
      reason: "`Peer Review` must start blank when a card is created",
      code: "peer_review_must_start_blank",
    };
  }

  return { ok: true, sections: parsed.sections };
}

/** Deterministic pipeline handlers (reschedule, done, missed) run as `system`. */
export const CONTRACT_EXEMPT_AGENT_IDS = new Set(["system"]);

export function evaluateContractWrite({
  agentId,
  classification,
  current = null,
  next = null,
  params = {},
  scopedListNames = DEFAULT_CONTRACT_SCOPED_LISTS,
  doneListNames = DEFAULT_DONE_LIST_NAMES,
}) {
  if (CONTRACT_EXEMPT_AGENT_IDS.has(agentId)) {
    return { ok: true, mode: "exempt" };
  }

  const plannedNext = projectContractNextSnapshot({ classification, params, current, next });

  const mode = classification?.mode || "unknown";
  if (mode === "non_structural") {
    return { ok: true, mode };
  }

  const currentScoped = current
    ? isContractScopedList(current.listName, { scopedListNames, doneListNames })
    : false;
  const nextScoped = plannedNext
    ? isContractScopedList(plannedNext.listName, { scopedListNames, doneListNames })
    : false;

  const currentValidation = currentScoped
    ? validateCardSnapshot(current)
    : { ok: true, skipped: true, sections: {} };
  const nextValidation = nextScoped
    ? validateCardSnapshot(plannedNext, { requireBlankPeerReview: !current })
    : { ok: true, skipped: true, sections: {} };

  if (!nextScoped) {
    if (currentScoped && !currentValidation.ok && mode === "structural") {
      return {
        ok: false,
        mode,
        reason: "Drifted contract cards must be repaired before structural changes continue",
        code: "card_requires_repair",
      };
    }
    return { ok: true, mode };
  }

  if (!nextValidation.ok) {
    if (currentScoped && !currentValidation.ok) {
      if (isRepairStep({ classification, current, next: plannedNext })) {
        return { ok: true, mode: "repair" };
      }
      return {
        ok: false,
        mode,
        reason: "Drifted contract cards must be repaired before structural changes continue",
        code: "card_requires_repair",
        details: nextValidation,
      };
    }
    return { ok: false, mode, ...nextValidation };
  }

  if (currentScoped && currentValidation.ok) {
    const mutationValidation = validateSectionMutations({
      agentId,
      currentSections: currentValidation.sections,
      nextSections: nextValidation.sections,
    });
    if (!mutationValidation.ok) {
      return { ok: false, mode, ...mutationValidation };
    }
  }

  if (currentScoped && !currentValidation.ok) {
    return { ok: true, mode: "repair" };
  }

  return { ok: true, mode };
}
