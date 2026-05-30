import fs from "node:fs";

/** Load KEY=VALUE lines into process.env without overriding existing keys. */
export function loadEnvFile(file, env = process.env) {
  if (!file || !fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !env[match[1]]) env[match[1]] = match[2];
  }
  return true;
}
