import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

export const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy-droplet.yml";
export const GITHUB_PR_BRIDGE_HEALTH_URL = "http://127.0.0.1:${GITHUB_PR_BRIDGE_PORT:-19091}/healthz";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export function readDeployWorkflowText() {
  return readFileSync(path.join(repoRoot, DEPLOY_WORKFLOW_PATH), "utf8");
}

export function getDeploySshScript() {
  const doc = parseDocument(readDeployWorkflowText(), { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new Error(`${DEPLOY_WORKFLOW_PATH}: YAML parse failed: ${doc.errors.map((error) => error.message).join("; ")}`);
  }

  const workflow = doc.toJSON();
  const steps = workflow?.jobs?.deploy?.steps ?? [];
  const sshStep = steps.find((step) => step.uses === "appleboy/ssh-action@v1.0.3");
  const script = sshStep?.with?.script;
  if (typeof script !== "string" || script.length === 0) {
    throw new Error(`${DEPLOY_WORKFLOW_PATH}: expected appleboy/ssh-action deploy script`);
  }
  return script;
}
