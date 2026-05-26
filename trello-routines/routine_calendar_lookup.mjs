export function parseRoutineTags(desc) {
  const id = String(desc || "").match(/routine-id:\s*(\S+)/i)?.[1] || null;
  const period = String(desc || "").match(/routine-period:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || null;
  return { routineId: id, routinePeriod: period };
}

export function eventToTrelloCard(event, openCards) {
  const description = String(event?.description || "");
  return (
    openCards.find((card) => {
      const shortUrl = String(card?.shortUrl || "");
      const shortLink = String(card?.shortLink || "");
      return (shortUrl && description.includes(shortUrl)) || (shortLink && description.includes(shortLink));
    }) || null
  );
}
