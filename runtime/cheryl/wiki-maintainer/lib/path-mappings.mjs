export const DEFAULT_PATH_MAPPINGS = [
  { from: /Docs\/Job Applications\//g, to: "wiki/job-search/" },
  { from: /Docs\/Internal Docs\//g, to: "wiki/runbooks/" },
  { from: /Docs\/Projects\//g, to: "wiki/projects/" },
  { from: /Docs\/Personal Admin\//g, to: "wiki/personal/" },
  { from: /Docs\/Reports\/(\d{4}-\d{2}-\d{2})\//g, to: "wiki/reports/$1/" },
  { from: /Docs\/Reports\//g, to: "wiki/reports/" },
];

export const WIKI_PUBLISH_PATH_MAPPINGS = [
  { from: /Docs\/Reports\/[^\s]+/g, to: "raw-input/" },
  { from: /Docs\/Internal Docs\/[^\s]+/g, to: "wiki/runbooks/" },
  { from: /Docs\/Job Applications\/[^\s]+/g, to: "wiki/job-search/" },
  { from: /Docs\/Personal Admin\/[^\s]+/g, to: "wiki/personal/" },
  { from: /Docs\/Projects\/[^\s]+/g, to: "wiki/projects/" },
];
