export function cardListName(card) {
  return (card?.list?.name || "").toLowerCase();
}

/** Missed-duplicate only when the card is still on Routine (Routine→Missed is allowed). */
export function shouldRoutineMissedDuplicate(card) {
  return cardListName(card) === "routine";
}
