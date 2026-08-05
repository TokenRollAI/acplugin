import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

export const RELEASE_ORDER = [
  '@tokenroll/acplugin-module-hooks',
  '@tokenroll/acplugin-module-mcp',
  '@tokenroll/acplugin',
];

function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    if (capture)
      child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout: stdout.trim() }));
  });
}

export async function publishReleaseCohort({
  version,
  packages = RELEASE_ORDER,
  attempts = 10,
  view = async (name) => {
    const result = await run('npm', ['view', `${name}@${version}`, 'version'], true);
    return result.code === 0 ? result.stdout : undefined;
  },
  publish = async (name) => {
    const result = await run('pnpm', ['--filter', name, 'publish', '--access', 'public', '--no-git-checks']);
    if (result.code !== 0)
      throw new Error(`Publication failed for ${name}@${version}.`);
  },
  wait = milliseconds => delay(milliseconds),
  log = message => process.stdout.write(`${message}\n`),
} = {}) {
  if (typeof version !== 'string' || version === '')
    throw new Error('A release version is required.');

  for (const name of packages) {
    if (await view(name) === version) {
      log(`${name}@${version} already exists; skipping publish.`);
    } else {
      await publish(name);
    }

    let verified = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (await view(name) === version) {
        verified = true;
        log(`Verified ${name}@${version}.`);
        break;
      }
      if (attempt < attempts)
        await wait(10_000);
    }
    if (!verified)
      throw new Error(`Registry did not expose ${name}@${version} after publication.`);
  }
}

async function selfTest() {
  const views = new Map();
  const published = [];
  const waited = [];
  const version = '1.0.0';
  await publishReleaseCohort({
    version,
    attempts: 3,
    view: async (name) => {
      const count = (views.get(name) ?? 0) + 1;
      views.set(name, count);
      if (name === '@tokenroll/acplugin-module-mcp')
        return version;
      if (name === '@tokenroll/acplugin')
        return count >= 3 ? version : undefined;
      return count >= 2 ? version : undefined;
    },
    publish: async name => published.push(name),
    wait: async milliseconds => waited.push(milliseconds),
    log: () => {},
  });
  const expected = ['@tokenroll/acplugin-module-hooks', '@tokenroll/acplugin'];
  if (JSON.stringify(published) !== JSON.stringify(expected) || waited.length !== 1)
    throw new Error('Release cohort skip/retry self-test failed.');

  let failed = false;
  try {
    await publishReleaseCohort({
      version,
      packages: ['@tokenroll/acplugin'],
      attempts: 2,
      view: async () => undefined,
      publish: async () => {},
      wait: async () => {},
      log: () => {},
    });
  } catch (error) {
    failed = error instanceof Error && error.message.includes('Registry did not expose');
  }
  if (!failed)
    throw new Error('Release cohort failure self-test failed.');
  process.stdout.write('Verified release cohort exact-version skip and bounded retry behavior.\n');
}

async function main() {
  if (process.argv[2] === '--self-test') {
    await selfTest();
    return;
  }
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const manifest = JSON.parse(await readFile(path.join(root, 'packages/acplugin/package.json'), 'utf8'));
  await publishReleaseCohort({ version: manifest.version });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
