export const NEXT_STEPS_CHECKLIST_NAME = "Next steps";

export const DEFAULT_SKIP_SWEEP_LISTS = new Set(["done"]);

export function shouldSkipCardForSweep(card, listName, { skipLists = DEFAULT_SKIP_SWEEP_LISTS } = {}) {
  if (card?.closed) return true;
  if (skipLists.has(String(listName || "").trim().toLowerCase())) return true;
  return false;
}

export function findNextStepsChecklists(checklists = []) {
  return checklists.filter((checklist) => String(checklist?.name || "").trim() === NEXT_STEPS_CHECKLIST_NAME);
}

export function planNextStepsRemoval(entries, { skipLists = DEFAULT_SKIP_SWEEP_LISTS } = {}) {
  const toDelete = [];
  const skipped = [];

  for (const entry of entries) {
    const { card, listName, checklists = [] } = entry;
    if (shouldSkipCardForSweep(card, listName, { skipLists })) {
      skipped.push({
        cardId: card.id,
        cardName: card.name,
        listName,
        reason: card?.closed ? "closed" : "done_list",
      });
      continue;
    }

    for (const checklist of findNextStepsChecklists(checklists)) {
      toDelete.push({
        cardId: card.id,
        cardName: card.name,
        listName,
        checklistId: checklist.id,
        checklistName: checklist.name,
      });
    }
  }

  return { toDelete, skipped };
}
