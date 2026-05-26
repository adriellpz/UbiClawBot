export function formatCalendarTimeRange(start, end) {
  const pad = (value) => String(value).padStart(2, "0");
  const offsetMinutes = -6 * 60;

  function format(date) {
    const value = date instanceof Date ? date : new Date(date);
    const shifted = new Date(value.getTime() + offsetMinutes * 60_000);
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:00-06:00`;
  }

  return `${format(start)} - ${format(end)}`;
}

export function buildDescription({ link, calendarTime, timeNeeded, body = "" }) {
  const parts = [];
  if (link) parts.push(String(link).trim());
  if (calendarTime) parts.push(`Calendar time: ${calendarTime}`);
  if (timeNeeded != null && timeNeeded !== "") parts.push(`Time needed: ${timeNeeded}`);

  const rest = String(body || "").trim();
  if (rest) parts.push(rest);
  return parts.join("\n\n");
}

export function eventHtmlLink(gogOutput) {
  try {
    const data = typeof gogOutput === "string" ? JSON.parse(gogOutput) : gogOutput;
    return data.event?.htmlLink || data.htmlLink || null;
  } catch {
    return null;
  }
}
