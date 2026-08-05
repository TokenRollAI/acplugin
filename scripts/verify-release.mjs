import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packages = [
  { name: '@tokenroll/acplugin-module-hooks' },
  { name: '@tokenroll/acplugin-module-mcp' },
  { name: '@tokenroll/acplugin' },
];
const privateNames = new Set([
  '@acplugin/core',
  '@acplugin/compiler-claude-code',
  '@acplugin/compiler-codex',
  '@acplugin/test',
]);

function run(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
      child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    }
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0)
        resolve({ stdout, stderr });
      else
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}.${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

function assert(condition, message) {
  if (!condition)
    throw new Error(message);
}

async function tarballFor(directory, name) {
  const before = new Set(await fs.readdir(directory));
  await run('pnpm', ['--filter', name, 'pack', '--pack-destination', directory], root);
  const created = (await fs.readdir(directory)).filter(file => file.endsWith('.tgz') && !before.has(file));
  assert(created.length === 1, `Expected one tarball for ${name}, found ${created.length}.`);
  return path.join(directory, created[0]);
}

async function inspectTarball(tarball, expectedName, extractRoot) {
  const listed = (await run('tar', ['-tzf', tarball], root, { capture: true })).stdout.trim().split('\n').filter(Boolean);
  assert(listed.every(file => file.startsWith('package/')), `${expectedName} tarball contains an entry outside package/.`);
  const leaked = listed.filter(file => /(?:^|\/)(?:src|test|__tests__)(?:\/|$)/.test(file) || /\.(?:ts|tsx)$/.test(file));
  assert(leaked.length === 0, `${expectedName} tarball leaks source/test files: ${leaked.join(', ')}`);
  assert(listed.includes('package/README.md'), `${expectedName} tarball is missing README.md.`);
  assert(listed.includes('package/LICENSE'), `${expectedName} tarball is missing LICENSE.`);

  const destination = path.join(extractRoot, expectedName.replace(/[^a-z0-9]+/gi, '-'));
  await fs.mkdir(destination, { recursive: true });
  await run('tar', ['-xzf', tarball, '-C', destination], root);
  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'package/package.json'), 'utf8'));
  assert(manifest.name === expectedName, `Packed manifest name mismatch for ${expectedName}.`);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dependency of Object.keys(manifest[field] ?? {}))
      assert(!privateNames.has(dependency), `${expectedName} exposes private runtime dependency ${dependency}.`);
  }
  return manifest;
}

async function verifyConsumer(tarballs, temporary) {
  const consumer = path.join(temporary, 'consumer');
  await fs.mkdir(path.join(consumer, 'src/skills/hello'), { recursive: true });
  const dependencies = Object.fromEntries(packages.map(item => [item.name, `file:${tarballs.get(item.name)}`]));
  await fs.writeFile(path.join(consumer, 'package.json'), `${JSON.stringify({
    name: 'acplugin-packed-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: {
      typecheck: 'tsc --noEmit',
      validate: 'acplugin validate --json',
      build: 'acplugin build --json',
    },
    dependencies,
    devDependencies: {
      '@types/node': '^20.19.0',
      'typescript': '^5.9.3',
    },
  }, null, 2)}\n`);
  await fs.writeFile(path.join(consumer, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      types: ['node'],
      skipLibCheck: true,
    },
    include: ['acplugin.config.ts'],
  }, null, 2)}\n`);
  await fs.writeFile(path.join(consumer, 'acplugin.config.ts'), `import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-module-hooks';
import mcp from '@tokenroll/acplugin-module-mcp';

export default defineConfig({
  name: 'packed-consumer',
  version: '1.0.0',
  description: 'Clean tarball consumer.',
  modules: [hooks(), mcp()],
});
`);
  await fs.writeFile(path.join(consumer, 'src/skills/hello/SKILL.md'), `---
description: Verify the packed consumer.
---
Validate that both target packages can be built from installed tarballs.
`);

  await run('pnpm', ['install', '--ignore-workspace'], consumer);
  await run('pnpm', ['run', 'typecheck'], consumer);
  await run('node', ['--input-type=module', '--eval', 'import(\'@tokenroll/acplugin\').then(m => { if (typeof m.defineConfig !== \'function\') process.exit(1) })'], consumer);
  const validate = await run('pnpm', ['exec', 'acplugin', 'validate', '--json'], consumer, { capture: true });
  assert(JSON.parse(validate.stdout).success === true, 'Packed consumer validation failed.');
  const build = await run('pnpm', ['exec', 'acplugin', 'build', '--json'], consumer, { capture: true });
  assert(JSON.parse(build.stdout).success === true, 'Packed consumer build failed.');
  await fs.access(path.join(consumer, 'dist/claude-code/.claude-plugin/plugin.json'));
  await fs.access(path.join(consumer, 'dist/codex/.codex-plugin/plugin.json'));
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-release-verify-'));
  try {
    const tarballDirectory = path.join(temporary, 'tarballs');
    const extractRoot = path.join(temporary, 'extract');
    await fs.mkdir(tarballDirectory, { recursive: true });
    const tarballs = new Map();
    const manifests = new Map();
    for (const item of packages) {
      const tarball = await tarballFor(tarballDirectory, item.name);
      tarballs.set(item.name, tarball);
      manifests.set(item.name, await inspectTarball(tarball, item.name, extractRoot));
    }
    const versions = new Set([...manifests.values()].map(manifest => manifest.version));
    assert(versions.size === 1, 'The public release cohort must use one version.');
    const version = [...versions][0];
    for (const moduleName of ['@tokenroll/acplugin-module-hooks', '@tokenroll/acplugin-module-mcp']) {
      const peerRange = manifests.get(moduleName).peerDependencies?.['@tokenroll/acplugin'];
      assert(peerRange === `^${version}`, `${moduleName} must pack with @tokenroll/acplugin peer range ^${version}.`);
    }
    await verifyConsumer(tarballs, temporary);
    process.stdout.write(`Verified three @tokenroll/acplugin ${version} tarballs in a clean consumer.\n`);
  } finally {
    if (process.env.ACPLUGIN_KEEP_RELEASE_TEMP !== '1')
      await fs.rm(temporary, { recursive: true, force: true });
    else
      process.stderr.write(`Release verification files retained at ${temporary}\n`);
  }
}

await main();
