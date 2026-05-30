import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

import { loadDeployManifest } from "./deploy/manifest.mjs";

export const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy-droplet.yml";
export const DEPLOY_REMOTE_SCRIPT_PATH = "scripts/deploy-droplet-remote.sh";
export const GITHUB_PR_BRIDGE_HEALTH_URL = "http://127.0.0.1:${GITHUB_PR_BRIDGE_PORT:-19091}/healthz";
export const GMAIL_HOOK_BRIDGE_HEALTH_URL = "http://127.0.0.1:${GMAIL_HOOK_BRIDGE_PORT:-19092}/healthz";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export function readDeployWorkflowText() {
  return readFileSync(path.join(repoRoot, DEPLOY_WORKFLOW_PATH), "utf8");
}

export function getDeployWorkflowYaml() {
  const doc = parseDocument(readDeployWorkflowText(), { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new Error(`${DEPLOY_WORKFLOW_PATH}: YAML parse failed: ${doc.errors.map((error) => error.message).join("; ")}`);
  }
  return doc.toJSON();
}

export function getDeploySshScript() {
  return readFileSync(path.join(repoRoot, DEPLOY_REMOTE_SCRIPT_PATH), "utf8");
}

export function getDeploySshWrapperScript() {
  const workflow = getDeployWorkflowYaml();
  const steps = workflow?.jobs?.deploy?.steps ?? [];
  const sshStep = steps.find((step) => step.uses === "appleboy/ssh-action@v1.0.3");
  const script = sshStep?.with?.script;
  if (typeof script !== "string" || script.length === 0) {
    throw new Error(`${DEPLOY_WORKFLOW_PATH}: expected appleboy/ssh-action deploy script`);
  }
  return script;
}

export function getDeployScpSources() {
  const workflow = getDeployWorkflowYaml();
  const steps = workflow?.jobs?.deploy?.steps ?? [];
  const sources = [];
  for (const step of steps) {
    if (step.uses !== "appleboy/scp-action@v0.1.7") continue;
    const source = step.with?.source;
    if (typeof source === "string" && source.length > 0) sources.push(source);
  }
  return sources;
}

export function getDeployPathFilters() {
  const workflow = getDeployWorkflowYaml();
  return workflow?.on?.push?.paths ?? [];
}

export { loadDeployManifest };

export function assertDeployWorkflowMatchesManifest() {
  const manifest = loadDeployManifest();
  const scpSources = getDeployScpSources();
  const sshScript = getDeploySshScript();
  const pathFilters = getDeployPathFilters();
  const issues = [];

  for (const bundle of manifest.copyBundles) {
    if (!scpSources.some((source) => source === bundle.scpSource)) {
      issues.push(`missing scp step for bundle ${bundle.id} (source: ${bundle.scpSource})`);
    }
    for (const marker of bundle.installMarkers) {
      if (!sshScript.includes(marker)) {
        issues.push(`ssh script missing install marker for ${bundle.id}: ${marker}`);
      }
    }
  }

  for (const file of manifest.gatewayFiles) {
    if (!sshScript.includes(file)) {
      issues.push(`ssh script missing gateway file copy: ${file}`);
    }
  }

  for (const service of manifest.composeRecreateServices) {
    if (!sshScript.includes(service)) {
      issues.push(`ssh script missing compose recreate service: ${service}`);
    }
  }

  for (const filter of manifest.pathFilters) {
    if (!pathFilters.includes(filter)) {
      issues.push(`workflow push path filter missing: ${filter}`);
    }
  }

  if (!sshScript.includes(manifest.revisionFile)) {
    issues.push(`ssh script does not write ${manifest.revisionFile}`);
  }

  for (const relativePath of manifest.smokeChecks.requiredFiles) {
    const marker = `smoke_required_file "${relativePath}"`;
    if (!sshScript.includes(marker)) {
      issues.push(`ssh script missing required-file smoke check: ${marker}`);
    }
  }

  for (const endpoint of manifest.smokeChecks.httpEndpoints) {
    if (!sshScript.includes(endpoint.url)) {
      issues.push(`ssh script missing http smoke check for ${endpoint.id}: ${endpoint.url}`);
    }
  }

  return issues;
}
