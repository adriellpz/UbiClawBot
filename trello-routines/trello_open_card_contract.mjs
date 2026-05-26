export const NEXT_STEPS_CHECKLIST_NAME = "Next steps";

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
  const sections = [
    ["Original Request", normalizeSectionContent(originalRequest)],
    ["Research", normalizeSectionContent(research)],
    ["Peer Review", normalizeSectionContent(peerReview)],
    ["Work completed", normalizeSectionContent(workCompleted)],
  ];

  return sections
    .flatMap(([title, content], index) => {
      const lines = [`${title}:`];
      if (content) lines.push(content);
      if (index < sections.length - 1) lines.push("");
      return lines;
    })
    .join("\n");
}

export function buildNextStepsChecklist(items = []) {
  const normalizedItems = items
    .map((item) => {
      if (typeof item === "string") return { name: item.trim() };
      return {
        name: String(item?.name || "").trim(),
        checked: item?.checked === true,
      };
    })
    .filter((item) => item.name);

  return {
    name: NEXT_STEPS_CHECKLIST_NAME,
    items: normalizedItems,
  };
}
