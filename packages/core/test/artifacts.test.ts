import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactRegistry, bytesArtifact } from '../src/index.js';

/** Artifact Registry 测试创建并统一清理的临时目录。 */
const temporaryDirectories: string[] = [];

/** @returns 已登记清理的 Artifact 来源根目录。 */
async function temporaryRoot(): Promise<string> {
  /** 当前测试独占的临时来源根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-artifacts-test-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('Artifact Registry', () => {
  it('snapshots bytes, computes metadata, and does not expose mutable content', async () => {
    /** 调用方在 add 后仍会修改的原始字节。 */
    const inputBytes = new Uint8Array([1, 2, 3]);
    /** 完成 owner、mode、size 与 hash 的 Artifact。 */
    const registry = new ArtifactRegistry(new Map());
    /** Registry 接管字节后生成的不可变 Artifact。 */
    const artifact = await registry.add('platform:test', bytesArtifact('config/data.bin', inputBytes));
    inputBytes[0] = 9;
    /** getter 返回且随后被调用方修改的隔离副本。 */
    const exposed = artifact.source.type === 'bytes' ? artifact.source.value : new Uint8Array();
    exposed[1] = 9;

    expect(artifact).toEqual(expect.objectContaining({ owner: 'platform:test', mode: 0o644, size: 3 }));
    expect(artifact.sha256).toHaveLength(64);
    expect(artifact.source.type === 'bytes' ? [...artifact.source.value] : []).toEqual([1, 2, 3]);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(registry.artifacts)).toBe(true);
  });

  it('rejects absolute, escaping, case, Unicode, and file-directory path conflicts', async () => {
    /** 当前冲突测试的独立 Registry。 */
    const registry = new ArtifactRegistry(new Map());
    await registry.add('platform:test', bytesArtifact('Assets/Café.txt', 'first'));

    await expect(registry.add('extension:test', bytesArtifact('assets/Cafe\u0301.txt', 'second'))).rejects.toThrow('collision');
    await expect(registry.add('extension:test', bytesArtifact('Assets/Café.txt/child', 'child'))).rejects.toThrow('file/directory');
    await expect(registry.add('extension:test', bytesArtifact('../escape', 'escape'))).rejects.toThrow('escapes');
    await expect(registry.add('extension:test', bytesArtifact('safe/../collapsed', 'escape'))).rejects.toThrow('parent-directory');
    await expect(registry.add('extension:test', bytesArtifact('/absolute', 'absolute'))).rejects.toThrow('relative');
    await expect(registry.add('extension:test', bytesArtifact('windows\\path', 'windows'))).rejects.toThrow('POSIX');
    await expect(registry.add('extension:test', bytesArtifact('nul\0path', 'nul'))).rejects.toThrow('NUL');
  });

  it('derives file mode and rejects outside or symlinked sources without retaining paths', async () => {
    /** Registry 允许读取的可信文件来源根。 */
    const root = await temporaryRoot();
    /** 可信根之外的文件来源。 */
    const outside = await temporaryRoot();
    await fs.writeFile(path.join(outside, 'outside.txt'), 'outside');
    /** 具有任意执行位、应收敛为 0755 的可信文件。 */
    const executable = path.join(root, 'tool');
    await fs.writeFile(executable, 'tool');
    await fs.chmod(executable, 0o711);
    /** 指向可信根外部目录的中间符号链接。 */
    await fs.symlink(outside, path.join(root, 'linked'));
    /** 当前文件来源测试 Registry。 */
    const registry = new ArtifactRegistry(new Map([
      ['platform:test', { roots: [root] }],
    ]));

    await expect(registry.add('platform:test', {
      path: 'retry.txt',
      source: { type: 'file', path: path.join(outside, 'outside.txt') },
    })).rejects.toThrow('outside allowed roots');
    await expect(registry.add('platform:test', {
      path: 'linked.txt',
      source: { type: 'file', path: path.join(root, 'linked', 'outside.txt') },
    })).rejects.toThrow('symbolic links');
    /** 失败后的同路径重试必须可以正常加入。 */
    const retry = await registry.add('platform:test', bytesArtifact('retry.txt', 'safe'));
    /** 未显式提供 mode 时从源文件执行位推导。 */
    const file = await registry.add('platform:test', { path: 'bin/tool', source: { type: 'file', path: executable } });
    expect(retry.size).toBe(4);
    expect(file.mode).toBe(0o755);
  });

  it('isolates scanned project files and Extension work directories by Artifact owner', async () => {
    /** 模拟 Scanner 已确认的 Component 文件所在工程。 */
    const projectRoot = await temporaryRoot();
    /** 唯一进入精确文件授权表的已扫描 Component。 */
    const scannedFile = path.join(projectRoot, 'src/skills/review/SKILL.md');
    /** 与已扫描文件同属工程、但没有被 Scanner 发现的任意文件。 */
    const unscannedFile = path.join(projectRoot, 'private.txt');
    await fs.mkdir(path.dirname(scannedFile), { recursive: true });
    await fs.writeFile(scannedFile, 'scanned');
    await fs.writeFile(unscannedFile, 'private');
    /** 两个 Extension 彼此隔离且不得交叉读取的工作目录。 */
    const extensionA = await temporaryRoot();
    /** 与 Extension A 隔离的第二个工作目录。 */
    const extensionB = await temporaryRoot();
    /** 仅由 Extension B 创建的本地产物。 */
    const extensionBFile = path.join(extensionB, 'built.txt');
    await fs.writeFile(extensionBFile, 'extension-b');
    /** 按完整 owner 限定精确文件或独占目录的 Registry。 */
    const registry = new ArtifactRegistry(new Map([
      ['platform:test', { files: [{ path: scannedFile, root: projectRoot }] }],
      ['extension:a', { roots: [extensionA] }],
      ['extension:b', { roots: [extensionB] }],
    ]));

    await expect(registry.add('platform:test', {
      path: 'private.txt', source: { type: 'file', path: unscannedFile },
    })).rejects.toThrow('outside allowed roots');
    await expect(registry.add('extension:a', {
      path: 'stolen.txt', source: { type: 'file', path: extensionBFile },
    })).rejects.toThrow('outside allowed roots');
    /** 精确授权的扫描文件仍可由对应 Platform 正常产出。 */
    const scanned = await registry.add('platform:test', {
      path: 'skills/review/SKILL.md', source: { type: 'file', path: scannedFile },
    });
    expect(scanned.owner).toBe('platform:test');
  });
});
