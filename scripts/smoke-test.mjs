import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const requiredFiles = [
  '.env.example',
  '.github/workflows/deploy-droplet.yml',
  'Caddyfile.droplet',
  'DEPLOY.md',
  'SECRETS-OPERATIONS.md',
  'config/openclaw.example.json',
  'workspace/Dockerfile.gog',
  'workspace/docker-compose.droplet.yml',
];

const failures = [];

for (const file of requiredFiles) {
  if (!existsSync(new URL(`../${file}`, import.meta.url))) failures.push(`missing ${file}`);
}

const read = async (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

try {
  JSON.parse(await read('config/openclaw.example.json'));
} catch (error) {
  failures.push(`config/openclaw.example.json is not valid JSON: ${error.message}`);
}

const compose = await read('workspace/docker-compose.droplet.yml');
for (const needle of [
  'services:',
  'openclaw-gateway:',
  'openclaw-cli:',
  'healthcheck:',
  'OPENCLAW_GATEWAY_TOKEN:',
  'TELEGRAM_BOT_TOKEN:',
  'OPENCLAW_GMAIL_WATCH_PORT:-8788}:8788',
  'trello-bridge:',
  'TRELLO_BRIDGE_PORT:-18990}:18990',
]) {
  if (!compose.includes(needle)) failures.push(`compose missing ${needle}`);
}

const workflow = await read('.github/workflows/deploy-droplet.yml');
for (const needle of ['workflow_dispatch:', 'DROPLET_HOST', 'appleboy/ssh-action', 'docker compose']) {
  if (!workflow.includes(needle)) failures.push(`deploy workflow missing ${needle}`);
}

const caddyfile = await read('Caddyfile.droplet');
for (const needle of ['reverse_proxy', '18789', '8788', '18990']) {
  if (!caddyfile.includes(needle)) failures.push(`Caddyfile missing ${needle}`);
}

const envExample = await read('.env.example');
if (/gho_[A-Za-z0-9_]+|xox[baprs]-|-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(envExample)) {
  failures.push('.env.example appears to contain a real secret');
}

if (failures.length) {
  console.error('Smoke test failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Smoke test passed: deploy config essentials are present and parseable.');
