import {
  bodyWithoutCalendarHeader,
  buildDescription,
  calendarLinks,
  formatCalendarTimeRange,
  parseCalendarLink,
  parseCalendarTimeLine,
} from "../../trello-pipeline/trello_card_calendar_desc.mjs";
import { hasRequiredOpenCardSections } from "../../trello-routines/trello_open_card_contract.mjs";

function explicitTimeNeeded(desc) {
  const match = String(desc || "").match(/Time needed:\s*(\d+)/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  return Number.isNaN(value) ? null : value;
}

function eventTimeRange(event) {
  const start = event?.start?.dateTime || event?.start?.date || null;
  const end = event?.end?.dateTime || event?.end?.date || null;
  if (!start || !end) return "";
  return formatCalendarTimeRange(start, end);
}

export function planDescriptionBackfill(card, { cfLink = "", cfTime = null, matchedEvents = [] } = {}) {
  const desc = String(card?.desc || "");
  const body = bodyWithoutCalendarHeader(desc);
  const existingLink = parseCalendarLink(desc) || "";
  const existingCalendarTime = parseCalendarTimeLine(desc) || "";
  const existingTimeNeeded = explicitTimeNeeded(desc);
  const hasLegacyData = Boolean(cfLink) || cfTime != null;

  let link = cfLink || existingLink || "";
  let linkSource = cfLink ? "custom_field" : existingLink ? "description" : null;

  if (!link) {
    if (matchedEvents.length > 1) {
      return { action: "issue", reason: "ambiguous_calendar_match", matchedEvents: matchedEvents.length };
    }
    if (matchedEvents.length === 1) {
      const eventLink = String(matchedEvents[0]?.htmlLink || "").trim();
      if (!eventLink) {
        return { action: "issue", reason: "matched_event_missing_html_link" };
      }
      link = eventLink;
      linkSource = "calendar_event";
    }
  }

  const calendarTime = existingCalendarTime || (matchedEvents.length === 1 ? eventTimeRange(matchedEvents[0]) : "");
  const timeNeeded = cfTime != null ? cfTime : existingTimeNeeded;

  if (!link && !calendarTime && timeNeeded == null && !hasLegacyData) {
    return { action: "skip", reason: "no_calendar_data" };
  }

  if (!hasRequiredOpenCardSections(body)) {
    return { action: "issue", reason: "body_contract_incomplete" };
  }

  const newDesc = buildDescription({
    link: link || undefined,
    calendarTime: calendarTime || undefined,
    timeNeeded: timeNeeded != null ? timeNeeded : undefined,
    body,
  });

  if (link && calendarLinks(newDesc).length !== 1) {
    return { action: "issue", reason: "bad_link_count", linkSource };
  }
  if (newDesc.trim() === desc.trim()) {
    return { action: "skip", reason: "no_change", linkSource };
  }

  return {
    action: "update",
    newDesc,
    linkSource,
    usedCalendarFallback: linkSource === "calendar_event",
  };
}
