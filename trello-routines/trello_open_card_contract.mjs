export const OPEN_CARD_SECTION_ORDER = ["Original Request", "Research", "Peer Review", "Work completed"];

function normalizeSectionContent(content) {
  if (Array.isArray(content)) {
    return content
      .map((line) => String(line ?? "").trimEnd())
      .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""))
      .join("\n")
      .trim();
  }

  return String(content ?? "").trim();
}

export function buildOpenCardDescription({
  originalRequest,
  research = "",
  peerReview = "",
  workCompleted = "",
}) {
  const sections = {
    "Original Request": normalizeSectionContent(originalRequest),
    Research: normalizeSectionContent(research),
    "Peer Review": normalizeSectionContent(peerReview),
    "Work completed": normalizeSectionContent(workCompleted),
  };

  return OPEN_CARD_SECTION_ORDER.flatMap((sectionName, index) => {
    const lines = [`${sectionName}:`];
    const content = sections[sectionName];
    if (content) lines.push(content);
    if (index < OPEN_CARD_SECTION_ORDER.length - 1) lines.push("");
    return lines;
  }).join("\n");
}

export function hasRequiredOpenCardSections(desc) {
  const matches = [...String(desc || "").matchAll(/^(Original Request|Research|Peer Review|Work completed):\s*$/gm)].map(
    (match) => match[1],
  );
  return matches.join("|") === OPEN_CARD_SECTION_ORDER.join("|");
}
