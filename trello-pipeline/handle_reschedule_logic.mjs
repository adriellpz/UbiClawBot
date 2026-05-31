export function cardListName(card) {
  return (card?.list?.name || "").toLowerCase();
}

/** Routine skip-today path: tomorrow already has this activity on the calendar. */
export function shouldRoutineMissedDuplicate(fromList, hasTomorrowEvent) {
  return fromList === "routine" && hasTomorrowEvent;
}

/** Gateway allows Routine→Missed but not Reschedule→Missed; hop through Routine when needed. */
export function needsRoutineBeforeMissed(card) {
  return cardListName(card) === "reschedule";
}
