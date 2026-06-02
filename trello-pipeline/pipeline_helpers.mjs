import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function makeGw(gatewayUrl, gatewayKey) {
  return async function gw(operation, cardId, params = {}) {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${gatewayKey}` },
      body: JSON.stringify({ agentId: "system", operation, cardId, params }),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`Gateway ${operation}: ${response.status} ${text.slice(0, 300)}`);
    return data;
  };
}

function gogEnv() {
  const env = { ...process.env };
  const gogBin = process.env.GOG_BIN || "gog";
  if (gogBin.includes("/")) {
    env.PATH = `${path.dirname(gogBin)}:${env.PATH || ""}`;
  }
  const passwordFile =
    process.env.GOG_KEYRING_PASSWORD_FILE || "/home/node/.openclaw/credentials/gog-keyring-password";
  if (!env.GOG_KEYRING_PASSWORD) {
    try {
      env.GOG_KEYRING_PASSWORD = fs.readFileSync(passwordFile, "utf8").trim();
    } catch {}
  }
  return env;
}

export function makeGog() {
  return function gog(args) {
    const gogBin = process.env.GOG_BIN || "gog";
    try {
      return execFileSync(gogBin, args, { encoding: "utf8", env: gogEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      if (/invalid_grant|Token has been expired/.test(error.stderr || "")) {
        throw new Error("GOG OAuth token expired");
      }
      throw error;
    }
  };
}
