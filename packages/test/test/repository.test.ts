import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../..', import.meta.url));

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(root, relativePath), 'utf8');
}

describe('repository release and documentation guards', () => {
  it('accepts only a tag matching the fixed public cohort', async () => {
    const manifest = JSON.parse(await read('packages/acplugin/package.json')) as { version: string };
    await expect(execFileAsync(process.execPath, ['scripts/verify-release-cohort.mjs', `tokenroll-v${manifest.version}`], { cwd: root })).resolves.toMatchObject({
      stdout: expect.stringContaining(`Verified fixed @tokenroll/acplugin ${manifest.version} release cohort`),
    });
    await expect(execFileAsync(process.execPath, ['scripts/verify-release-cohort.mjs', 'tokenroll-v9.9.9'], { cwd: root })).rejects.toThrow(`must equal tokenroll-v${manifest.version}`);
  });

  it('keeps the release workflow dependency-safe and credentialless', async () => {
    const workflow = await read('.github/workflows/publish-npm.yml');
    const publisher = await read('scripts/publish-release-cohort.mjs');
    const hooks = publisher.indexOf('@tokenroll/acplugin-module-hooks');
    const mcp = publisher.indexOf('@tokenroll/acplugin-module-mcp');
    const main = publisher.indexOf('@tokenroll/acplugin', mcp + 1);

    expect(workflow).toContain('tags:\n      - "tokenroll-v*"');
    expect(workflow).toContain('node scripts/verify-release-cohort.mjs "$GITHUB_REF_NAME"');
    expect(workflow).toContain('run: node scripts/publish-release-cohort.mjs');
    expect(hooks).toBeGreaterThan(-1);
    expect(mcp).toBeGreaterThan(hooks);
    expect(main).toBeGreaterThan(mcp);
    expect(`${workflow}\n${publisher}`).not.toMatch(/NPM_TOKEN|npm-token|npm unpublish|npm dist-tag/i);
    await expect(execFileAsync(process.execPath, ['scripts/publish-release-cohort.mjs', '--self-test'], { cwd: root })).resolves.toMatchObject({
      stdout: expect.stringContaining('Verified release cohort exact-version skip and bounded retry behavior.'),
    });
  });

  it('keeps current docs free of the retired namespace and CLI', async () => {
    const docs = await Promise.all([
      'README.md',
      'README.zh-CN.md',
      'AGENTS.md',
      'llmdoc/index.md',
      'llmdoc/startup.md',
      'llmdoc/overview/project.md',
      'llmdoc/architecture/system.md',
      'llmdoc/guides/usage.md',
      'llmdoc/guides/release.md',
      'llmdoc/reference/conversion-matrix.md',
    ].map(read));
    const currentDocumentation = docs.join('\n');

    expect(currentDocumentation).not.toContain('@disdjj/acplugin');
    expect(currentDocumentation).not.toMatch(/\bacplugin (?:scan|convert)\b/);
    expect(currentDocumentation).not.toContain('src/converter/');
    expect(currentDocumentation).not.toContain('.github/workflows/acplugin.yml');
  });
});
