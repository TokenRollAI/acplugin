import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { checkbox, input } from '@inquirer/prompts';

export interface InitOptions {
  cwd?: string;
  directory?: string;
  yes?: boolean;
  name?: string;
  displayName?: string;
  description?: string;
  hooks?: boolean;
  mcp?: boolean;
  install?: boolean;
}

export interface InitResult {
  directory: string;
  files: readonly string[];
  modules: readonly string[];
  installed: boolean;
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function defaultName(directory: string): string {
  return path.basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'my-plugin';
}

function defaultDisplayName(name: string): string {
  return name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

async function assertDestination(directory: string): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('destination exists and is not a regular directory');
    if ((await fs.readdir(directory)).length > 0)
      throw new Error('destination directory is not empty');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return;
    throw error;
  }
}

function configSource(metadata: {
  name: string;
  displayName: string;
  description: string;
  hooks: boolean;
  mcp: boolean;
}): string {
  const imports = [`import { defineConfig } from '@tokenroll/acplugin';`];
  const modules: string[] = [];
  if (metadata.hooks) {
    imports.push(`import hooks from '@tokenroll/acplugin-module-hooks';`);
    modules.push('hooks()');
  }
  if (metadata.mcp) {
    imports.push(`import mcp from '@tokenroll/acplugin-module-mcp';`);
    modules.push('mcp()');
  }
  return `${imports.join('\n')}

export default defineConfig({
  name: ${JSON.stringify(metadata.name)},
  version: '0.1.0',
  description: ${JSON.stringify(metadata.description)},
  displayName: ${JSON.stringify(metadata.displayName)},${modules.length
    ? `
  modules: [${modules.join(', ')}],`
    : ''}
});
`;
}

function packageSource(name: string, hooks: boolean, mcp: boolean): string {
  const devDependencies: Record<string, string> = {
    '@tokenroll/acplugin': '^1.0.0',
    '@types/node': '^20.19.0',
    'typescript': '^5.9.3',
  };
  if (hooks)
    devDependencies['@tokenroll/acplugin-module-hooks'] = '^1.0.0';
  if (mcp)
    devDependencies['@tokenroll/acplugin-module-mcp'] = '^1.0.0';
  return `${JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    packageManager: 'pnpm@10.34.5',
    engines: { node: '>=20' },
    scripts: {
      dev: 'acplugin dev',
      validate: 'acplugin validate',
      inspect: 'acplugin inspect',
      build: 'acplugin build',
      typecheck: 'tsc --noEmit',
    },
    devDependencies,
  }, null, 2)}\n`;
}

async function installDependencies(directory: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['install'], { cwd: directory, stdio: 'inherit' });
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
  });
}

export async function initializeProject(options: InitOptions): Promise<InitResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  let directoryValue = options.directory;
  if (!directoryValue) {
    if (options.yes || !process.stdin.isTTY)
      throw new Error('A destination directory is required in non-interactive mode; pass "." explicitly for the current directory.');
    directoryValue = await input({ message: 'Project directory', default: 'my-plugin' });
  }
  const directory = path.resolve(cwd, directoryValue);
  await assertDestination(directory);

  const suggestedName = defaultName(directory);
  const name = options.name ?? (options.yes || !process.stdin.isTTY
    ? suggestedName
    : await input({ message: 'Plugin name', default: suggestedName }));
  if (!NAME_PATTERN.test(name))
    throw new Error('Plugin name must be lowercase kebab-case.');
  const suggestedDisplayName = defaultDisplayName(name);
  const displayName = options.displayName ?? (options.yes || !process.stdin.isTTY
    ? suggestedDisplayName
    : await input({ message: 'Display name', default: suggestedDisplayName }));
  const description = options.description ?? (options.yes || !process.stdin.isTTY
    ? `${displayName} plugin.`
    : await input({ message: 'Description', default: `${displayName} plugin.` }));
  if (description.trim() === '')
    throw new Error('Description must not be empty.');

  let hooksEnabled = options.hooks ?? false;
  let mcpEnabled = options.mcp ?? false;
  if (!options.yes && process.stdin.isTTY && options.hooks === undefined && options.mcp === undefined) {
    const selected = await checkbox({
      message: 'Optional Modules',
      choices: [
        { name: 'Hooks', value: 'hooks' },
        { name: 'MCP', value: 'mcp' },
      ],
    });
    hooksEnabled = selected.includes('hooks');
    mcpEnabled = selected.includes('mcp');
  }

  const skillDirectory = path.join(directory, 'src', 'skills', name);
  await fs.mkdir(skillDirectory, { recursive: true });
  const files = [
    'acplugin.config.ts',
    'package.json',
    'tsconfig.json',
    '.gitignore',
    `src/skills/${name}/SKILL.md`,
  ];
  await Promise.all([
    fs.writeFile(path.join(directory, 'acplugin.config.ts'), configSource({ name, displayName, description: description.trim(), hooks: hooksEnabled, mcp: mcpEnabled }), { flag: 'wx' }),
    fs.writeFile(path.join(directory, 'package.json'), packageSource(name, hooksEnabled, mcpEnabled), { flag: 'wx' }),
    fs.writeFile(path.join(directory, 'tsconfig.json'), `${JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        types: ['node'],
        skipLibCheck: true,
      },
      include: ['acplugin.config.ts', 'src/**/*.ts'],
    }, null, 2)}\n`, { flag: 'wx' }),
    fs.writeFile(path.join(directory, '.gitignore'), 'node_modules\ndist\n', { flag: 'wx' }),
    fs.writeFile(path.join(skillDirectory, 'SKILL.md'), `---
description: Describe when and why to use ${displayName}.
---
Replace this text with the focused workflow ${displayName} should perform.
`, { flag: 'wx' }),
  ]);

  const installed = options.install ? await installDependencies(directory) : false;
  return {
    directory: path.relative(cwd, directory) || '.',
    files,
    modules: [
      ...(hooksEnabled ? ['@tokenroll/acplugin-module-hooks'] : []),
      ...(mcpEnabled ? ['@tokenroll/acplugin-module-mcp'] : []),
    ],
    installed,
  };
}
