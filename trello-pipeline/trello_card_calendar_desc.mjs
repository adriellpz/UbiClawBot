export const CALENDAR_EID_RE = /https:\/\/www\.google\.com\/calendar\/event\?eid=[^\s)\]]+/g;
export const NO_CALENDAR_RE = /Ubi-only\/no-calendar/i;

export function calendarLinks(desc) {
  return [...String(desc || "").matchAll(CALENDAR_EID_RE)].map((match) => match[0]);
}

export function isNoCalendarCard(desc) {
  return NO_CALENDAR_RE.test(String(desc || ""));
}

export function firstNonEmptyLine(desc) {
  for (const line of String(desc || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function parseCalendarLink(desc) {
  const links = calendarLinks(desc);
  return links.length ? links[0] : null;
}

export function assertSingleCalendarLink(desc) {
  if (isNoCalendarCard(desc)) return [];
  const issues = [];
  const links = calendarLinks(desc);
  if (!links.length) issues.push("missing_calendar_link");
  if (links.length > 1) issues.push("multiple_calendar_links");
  if (links.length === 1 && firstNonEmptyLine(desc) !== links[0]) issues.push("calendar_link_not_first_line");
  return issues;
}

export function parseTimeNeeded(desc, defaultMin = 30) {
  const match = String(desc || "").match(/Time needed:\s*(\d+)/i);
  if (!match) return Math.max(15, Math.min(120, defaultMin));
  const value = parseInt(match[1], 10);
  if (Number.isNaN(value) || value <= 0) return Math.max(15, Math.min(120, defaultMin));
  return Math.max(15, Math.min(120, value));
}

export function parseCalendarTimeLine(desc) {
  const match = String(desc || "").match(/Calendar time:\s*([^\n]+)/i);
  return match ? match[1].trim() : "";
}

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

export function bodyWithoutCalendarHeader(desc) {
  const lines = String(desc || "").split(/\r?\n/);
  const out = [];
  let inHeader = true;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inHeader) {
      if (!trimmed) continue;
      if (CALENDAR_EID_RE.test(trimmed) || /^Calendar time:/i.test(trimmed) || /^Time needed:/i.test(trimmed)) continue;
      inHeader = false;
      out.push(line);
    } else {
      out.push(line);
    }
  }

  let body = out.join("\n").trim();
  for (const url of calendarLinks(body)) {
    body = body.split(url).join("").replace(/\n{3,}/g, "\n\n").trim();
  }
  return body;
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

export function upsertCalendarBlock(desc, { link, calendarTime, timeNeeded }) {
  const body = bodyWithoutCalendarHeader(desc);
  const minutes = timeNeeded != null ? timeNeeded : parseTimeNeeded(desc);
  return buildDescription({ link, calendarTime, timeNeeded: minutes, body });
}

export function eventHtmlLink(gogOutput) {
  try {
    const data = typeof gogOutput === "string" ? JSON.parse(gogOutput) : gogOutput;
    return data.event?.htmlLink || data.htmlLink || null;
  } catch {
    return null;
  }
}
