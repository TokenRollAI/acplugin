import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildSessionScope } from '../../src/lifecycle/session-scope.js';
import { SourcePathCollisionRegistry } from '../../src/security/path-policy.js';
import { SourceRegistry } from '../../src/services/sources.js';

/** Source Registry 测试创建的临时工程根。 */
const roots: string[] = [];

/**
 * 创建包含 src/owned 的临时工程。
 *
 * @returns 工程根和 Source root 绝对路径。
 */
async function project(): Promise<{ readonly root: string; readonly sourceRoot: string }> {
  /** 当前测试独占的工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-source-registry-'));
  roots.push(root);
  /** Extension 独占的作者来源根。 */
  const sourceRoot = path.join(root, 'src', 'owned');
  await fs.mkdir(path.join(sourceRoot, 'nested'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'alpha.ts'), 'export const alpha = 1;\n');
  await fs.writeFile(path.join(sourceRoot, 'nested', 'beta.ts'), 'export const beta = 2;\n');
  return { root, sourceRoot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('SourceRegistry', () => {
  it('issues safe refs, lists deterministically and reads exact source bytes', async () => {
    /** 当前测试独占的临时工程。 */
    const fixture = await project();
    /** 本轮独占 capability scope。 */
    const scope = new BuildSessionScope();
    /** 当前工程唯一 Source Registry。 */
    const registry = new SourceRegistry(scope, fixture.root);
    /** owner-scoped 根目录能力。 */
    const root = await registry.issueRoot('extension:owned', fixture.sourceRoot);
    /** owner 无法填写或修改的闭包服务。 */
    const sources = registry.service('extension:owned');
    /** 递归列表必须使用工程相对路径而非绝对路径。 */
    const entries = await sources.list(root, { recursive: true });
    /** 非递归列表只能包含直接子项。 */
    const directEntries = await sources.list(root);
    /** 从 root 精确签发的文件 ref。 */
    const alpha = await sources.file(root, 'alpha.ts');

    expect(root.path).toBe('src/owned');
    expect(entries.map(entry => entry.path)).toEqual([
      'src/owned/alpha.ts',
      'src/owned/nested',
      'src/owned/nested/beta.ts',
    ]);
    expect(directEntries.map(entry => entry.path)).toEqual(['src/owned/alpha.ts', 'src/owned/nested']);
    expect(entries.every(entry => !path.isAbsolute(entry.path))).toBe(true);
    expect(await sources.readText(alpha)).toBe('export const alpha = 1;\n');
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(entries)).toBe(true);
  });

  it('rejects ambiguous paths, forged refs, cross-owner refs and expired sessions', async () => {
    /** 当前测试独占的临时工程。 */
    const fixture = await project();
    /** 当前测试独占 capability scope。 */
    const scope = new BuildSessionScope();
    /** 当前工程唯一 Source Registry。 */
    const registry = new SourceRegistry(scope, fixture.root);
    /** extension-a 的来源根。 */
    const root = await registry.issueRoot('extension:a', fixture.sourceRoot);
    /** extension-a 的闭包服务。 */
    const owner = registry.service('extension:a');
    /** extension-b 不应得到 a 的 ref 权限。 */
    const other = registry.service('extension:b');
    /** 正式签发的文件 ref。 */
    const file = await owner.file(root, 'alpha.ts');
    /** 复制公共字段和 Symbol 也不在 Registry WeakMap 中。 */
    const forged = Object.freeze({ ...file }) as typeof file;

    for (const invalid of ['/absolute.ts', '../escape.ts', './dot.ts', 'nested//file.ts', 'nested\\file.ts'])
      await expect(owner.file(root, invalid)).rejects.toThrow();
    await expect(owner.read(forged)).rejects.toThrow('not authorized');
    await expect(other.read(file)).rejects.toThrow('not authorized');
    scope.close();
    await expect(owner.read(file)).rejects.toThrow('no longer active');
  });

  it('rejects author symlinks and source mutation into a symlink', async () => {
    /** 当前测试独占的临时工程。 */
    const fixture = await project();
    /** 当前测试独占 capability scope。 */
    const scope = new BuildSessionScope();
    /** 当前工程唯一 Source Registry。 */
    const registry = new SourceRegistry(scope, fixture.root);
    /** 合法作者来源根。 */
    const root = await registry.issueRoot('extension:owned', fixture.sourceRoot);
    /** 当前 owner 的闭包服务。 */
    const sources = registry.service('extension:owned');
    /** 首次签发时仍为普通文件。 */
    const file = await sources.file(root, 'alpha.ts');
    /** 工程外目标用于验证 symlink 逃逸。 */
    const outside = path.join(fixture.root, 'outside.ts');
    await fs.writeFile(outside, 'secret\n');
    await fs.symlink(outside, path.join(fixture.sourceRoot, 'link.ts'));

    await expect(sources.list(root)).rejects.toThrow('symbolic links');
    await fs.rm(path.join(fixture.sourceRoot, 'alpha.ts'));
    await fs.symlink(outside, path.join(fixture.sourceRoot, 'alpha.ts'));
    await expect(sources.read(file)).rejects.toThrow('symbolic links');
  });

  it('rejects ordinary content mutation after a FileRef was issued', async () => {
    /** 当前测试独占的临时工程。 */
    const fixture = await project();
    /** 当前测试独占 capability scope。 */
    const scope = new BuildSessionScope();
    /** 当前工程唯一 Source Registry。 */
    const registry = new SourceRegistry(scope, fixture.root);
    /** 当前 owner 的来源根和服务。 */
    const root = await registry.issueRoot('extension:owned', fixture.sourceRoot);
    /** 当前 owner 的闭包 Source Service。 */
    const sources = registry.service('extension:owned');
    /** 内容修改前签发的 FileRef。 */
    const file = await sources.file(root, 'alpha.ts');
    await fs.writeFile(path.join(fixture.sourceRoot, 'alpha.ts'), 'export const alpha = 2;\n');

    await expect(sources.read(file)).rejects.toThrow('changed after');
  });

  it('rejects special files and enforces bounded strict UTF-8 reads', async () => {
    if (process.platform === 'win32')
      return;
    /** 当前测试独占的临时工程。 */
    const fixture = await project();
    /** FIFO 路径用于验证非普通文件拒绝。 */
    const fifo = path.join(fixture.sourceRoot, 'pipe');
    /** 使用 mkfifo 创建不会被 readdir Dirent 误判为普通文件的 fixture。 */
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => execFile('mkfifo', [fifo], error => error ? reject(error) : resolve()));
    /** 无效 UTF-8 文件用于验证 fatal decoder。 */
    await fs.writeFile(path.join(fixture.sourceRoot, 'invalid.bin'), Uint8Array.of(0xC3, 0x28));
    /** 当前测试独占 capability scope。 */
    const scope = new BuildSessionScope();
    /** 当前工程唯一 Source Registry。 */
    const registry = new SourceRegistry(scope, fixture.root);
    /** 合法作者来源根。 */
    const root = await registry.issueRoot('extension:owned', fixture.sourceRoot);
    /** 当前 owner 的闭包服务。 */
    const sources = registry.service('extension:owned');
    /** 无效 UTF-8 文件仍可作为字节来源签发。 */
    const invalid = await sources.file(root, 'invalid.bin');

    await expect(sources.list(root)).rejects.toThrow('regular files');
    await expect(sources.read(invalid, { maxBytes: 1 })).rejects.toThrow('read limit');
    await expect(sources.readText(invalid)).rejects.toThrow();
  });

  it('detects exact, case-folded and Unicode NFC source collisions without locale rules', () => {
    /** 独立 collision registry 能验证当前大小写敏感文件系统不易创建的 fixture。 */
    const collisions = new SourcePathCollisionRegistry();
    collisions.reserve('src/owned/Foo.ts', '/physical/Foo.ts');
    expect(() => collisions.reserve('src/owned/foo.ts', '/physical/foo.ts')).toThrow('collision');

    /** 第二个 registry 隔离 Unicode 归一化场景。 */
    const unicode = new SourcePathCollisionRegistry();
    unicode.reserve('src/owned/caf\u00e9.ts', '/physical/composed.ts');
    expect(() => unicode.reserve('src/owned/cafe\u0301.ts', '/physical/decomposed.ts')).toThrow('collision');
  });

  it('keeps dependency-manager symlinks outside author-source policy', async () => {
    /** 当前测试独占的临时工程。 */
    const fixture = await project();
    /** 模拟 pnpm node_modules package link，但不把它登记成作者 root。 */
    const store = path.join(fixture.root, '.pnpm-store', 'package');
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, 'index.js'), 'export {};\n');
    await fs.mkdir(path.join(fixture.root, 'node_modules'), { recursive: true });
    await fs.symlink(store, path.join(fixture.root, 'node_modules', 'package'));
    /** 当前测试独占 capability scope。 */
    const scope = new BuildSessionScope();
    /** Source Registry 只管理显式作者 root。 */
    const registry = new SourceRegistry(scope, fixture.root);
    /** 作者 root 的签发和枚举不受工程其他位置依赖 symlink 影响。 */
    const root = await registry.issueRoot('extension:owned', fixture.sourceRoot);

    await expect(registry.service('extension:owned').list(root)).resolves.toEqual(expect.any(Array));
  });
});
