import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** 当前 monorepo 根目录和真实注释检查入口。 */
const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
/** 由临时 fixture 子进程执行的注释检查脚本。 */
const checker = path.join(repositoryRoot, 'scripts/check-comments.mjs');
/** 每个测试结束后需要删除的临时仓库根。 */
const temporaryRoots: string[] = [];

/**
 * 运行注释覆盖脚本并捕获退出状态与诊断。
 *
 * @param root 临时 monorepo 根目录。
 * @returns 子进程退出码和标准错误。
 */
async function runChecker(root: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    /** 使用真实 Node 入口检查临时 workspace 布局。 */
    const child = spawn(process.execPath, [checker, '--root', root], { stdio: ['ignore', 'ignore', 'pipe'] });
    /** 当前检查失败产生的完整诊断文本。 */
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
}

/**
 * 创建只遗漏一个新增生产文件的最小 monorepo fixture。
 *
 * @param packagePath 待验证 package 相对于 packages 的层级。
 * @returns fixture 根目录和未覆盖生产文件路径。
 */
async function coverageFixture(packagePath: string): Promise<{ root: string; missing: string }> {
  /** 当前布局测试独占的临时 monorepo 根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-comment-coverage-'));
  temporaryRoots.push(root);
  /** 当前顶层、Platform 或 Extension package 根。 */
  const packageRoot = path.join(root, 'packages', packagePath);
  await fs.mkdir(path.join(packageRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), '{"name":"fixture","private":true}\n');
  await fs.writeFile(path.join(packageRoot, 'src/covered.ts'), '/** 已覆盖声明。 */\nexport const covered = true;\n');
  await fs.writeFile(path.join(packageRoot, 'src/new.ts'), '/** 新增声明。 */\nexport const added = true;\n');
  /** coverage 清单故意只包含既有生产文件。 */
  const covered = `packages/${packagePath}/src/covered.ts`;
  await fs.writeFile(path.join(root, 'scripts/comment-coverage.json'), `${JSON.stringify({
    schemaVersion: 1,
    enforcedFiles: [covered],
  }, null, 2)}\n`);
  return { root, missing: `packages/${packagePath}/src/new.ts` };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('comment coverage workspace discovery', () => {
  it.each([
    ['top-level package', 'tool'],
    ['Platform package', 'platforms/community'],
    ['Extension package', 'extensions/community'],
  ])('rejects an uncovered production file in a %s', async (_label, packagePath) => {
    /** 当前 workspace 深度对应的未覆盖 fixture。 */
    const fixture = await coverageFixture(packagePath);
    /** 真实检查器执行后的结构失败。 */
    const result = await runChecker(fixture.root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('以下生产文件未加入中文注释覆盖');
    expect(result.stderr).toContain(fixture.missing);
  });
});
