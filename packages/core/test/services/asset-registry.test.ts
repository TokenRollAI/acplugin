import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetRef, PackageComponentOrigin } from '../../src/api/integration.js';
import { AssetRegistry } from '../../src/services/assets.js';
import { BuildSessionScope } from '../../src/services/session-scope.js';
import { SourceRegistry } from '../../src/services/sources.js';
import { WorkDirectoryRegistry } from '../../src/services/work-directories.js';

/** Asset Registry 测试创建的临时根。 */
const roots: string[] = [];

/**
 * 创建一套共享同一 BuildSession 的 Source/Work/Asset Registry。
 *
 * @returns 测试 fixture 和 Registry 集合。
 */
async function registries() {
  /** 当前测试独占工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-asset-registry-'));
  roots.push(root);
  /** 作者来源根。 */
  const sourceRoot = path.join(root, 'src', 'owned');
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'source.txt'), 'source bytes\n');
  /** Core 内部 workDir 父目录。 */
  const workRoot = path.join(root, '.work');
  /** 当前 BuildSession capability scope。 */
  const scope = new BuildSessionScope();
  /** 当前 Session Source Registry。 */
  const sources = new SourceRegistry(scope, root);
  /** 当前 Session WorkDir Registry。 */
  const work = new WorkDirectoryRegistry(scope, workRoot);
  /** 当前 Session Asset Registry。 */
  const assets = new AssetRegistry(scope, sources, work);
  return { root, sourceRoot, scope, sources, work, assets };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('AssetRegistry', () => {
  it('copies bytes, binds owner and reports stable generated provenance', async () => {
    /** 当前测试独占的 Registry 集合。 */
    const fixture = await registries();
    /** 调用方保留并将在签发后修改的原始字节。 */
    const input = Uint8Array.of(1, 2, 3);
    /** extension owner 的闭包 Asset Service。 */
    const service = fixture.assets.service('extension:owned');
    /** 带稳定 operation/subjects 的内存 Asset。 */
    const asset = await service.fromBytes({
      bytes: input,
      mode: 0o755,
      origin: { operation: 'hook-runner', subjects: ['hook:beta', 'hook:alpha'] },
    });
    input[0] = 9;
    /** 对外报告不包含私有 bytes 或物理路径。 */
    const description = fixture.assets.describe('extension:owned', asset);

    expect([...await service.read(asset)]).toEqual([1, 2, 3]);
    expect(description.owner).toBe('extension:owned');
    expect(description.mode).toBe(0o755);
    expect(description.sha256).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
    expect(description.origin).toEqual({
      type: 'generated',
      owner: 'extension:owned',
      operation: 'hook-runner',
      subjects: ['hook:alpha', 'hook:beta'],
    });
    expect(JSON.stringify(asset)).not.toContain(fixture.root);
  });

  it('rejects coercible, unknown-field and behavior-bearing Bytes Asset inputs', async () => {
    const fixture = await registries();
    const service = fixture.assets.service('extension:owned');

    await expect(service.fromBytes({
      bytes: [1, 2, 3], origin: { operation: 'array-like' },
    } as never)).rejects.toThrow('string or Uint8Array');
    await expect(service.fromBytes({
      bytes: 'hidden', origin: { operation: 'unknown-input' }, hidden: true,
    } as never)).rejects.toThrow('Bytes Asset input contains unknown field "hidden"');
    await expect(service.fromBytes({
      bytes: 'hidden', origin: { operation: 'unknown-origin', hidden: true },
    } as never)).rejects.toThrow('Generated Asset origin contains unknown field "hidden"');

    let getterCalls = 0;
    const accessorSubjects: string[] = [];
    Object.defineProperty(accessorSubjects, '0', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'fixture:subject';
      },
    });
    accessorSubjects.length = 1;
    await expect(service.fromBytes({
      bytes: 'accessor', origin: { operation: 'accessor-subjects', subjects: accessorSubjects },
    })).rejects.toThrow('dense');
    expect(getterCalls).toBe(0);
    await expect(service.fromBytes({
      bytes: 'sparse', origin: { operation: 'sparse-subjects', subjects: new Array<string>(1) },
    })).rejects.toThrow('dense');
  });

  it('uses owner-local ref identities that do not reveal cross-owner scheduling', async () => {
    /** 第一轮 Registry 模拟 owner-b 先完成。 */
    const first = await registries();
    /** 第一轮先由 owner-b 签发，模拟相反并发完成顺序。 */
    await first.assets.service('extension:b').fromBytes({ bytes: 'b', origin: { operation: 'build' } });
    /** 第一轮 owner-a 的首个 ref。 */
    const firstA = await first.assets.service('extension:a').fromBytes({ bytes: 'a', origin: { operation: 'build' } });
    /** 第二轮 Registry 模拟 owner-a 先完成。 */
    const second = await registries();
    /** 第二轮 owner-a 先签发。 */
    const secondA = await second.assets.service('extension:a').fromBytes({ bytes: 'a', origin: { operation: 'build' } });

    expect(firstA.id).toBe(secondA.id);
  });

  it('accepts Component provenance only through the current finalization scope and revokes it afterward', async () => {
    const fixture = await registries();
    /** Core registry signs origin identity during Package merge. */
    const alpha = fixture.assets.issueComponentOrigin('target', 'extension:alpha', 'private:alpha');
    const zeta = fixture.assets.issueComponentOrigin('target', 'extension:zeta', 'private:zeta');
    const scope = fixture.assets.componentFinalizationScope('target', 'platform:target', [{ origin: zeta }, { origin: alpha }]);
    const asset = await scope.service.fromBytes({
      bytes: 'rendered\n',
      origin: {
        operation: 'platform-component',
        subjects: ['private:zeta', 'private:alpha'],
        componentOrigins: [zeta, alpha],
      },
    });
    expect(fixture.assets.describe('platform:target', asset).origin).toEqual({
      type: 'generated', owner: 'platform:target', operation: 'platform-component',
      contributors: [
        { owner: 'extension:alpha', subject: 'private:alpha' },
        { owner: 'extension:zeta', subject: 'private:zeta' },
      ],
      subjects: ['private:alpha', 'private:zeta'],
    });
    await expect(scope.service.fromBytes({
      bytes: 'mismatched',
      origin: {
        operation: 'platform-component',
        subjects: ['private:zeta'],
        componentOrigins: [alpha],
      },
    })).rejects.toThrow('is not declared by its Component origins');
    await expect(scope.service.fromBytes({
      bytes: 'forged', origin: { operation: 'platform-component', componentOrigins: [Object.freeze({ owner: 'extension:alpha', subject: 'private:alpha' }) as PackageComponentOrigin] },
    })).rejects.toThrow('not authorized');
    await expect(scope.service.fromBytes({
      bytes: 'duplicate', origin: { operation: 'platform-component', componentOrigins: [alpha, alpha] },
    })).resolves.toBeDefined();
    let getterCalls = 0;
    const accessorOrigins: PackageComponentOrigin[] = [];
    Object.defineProperty(accessorOrigins, '0', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return alpha;
      },
    });
    accessorOrigins.length = 1;
    await expect(scope.service.fromBytes({
      bytes: 'accessor', origin: { operation: 'platform-component', componentOrigins: accessorOrigins },
    })).rejects.toThrow('dense');
    expect(getterCalls).toBe(0);
    const sparseOrigins = new Array<PackageComponentOrigin>(1);
    await expect(scope.service.fromBytes({
      bytes: 'sparse', origin: { operation: 'platform-component', componentOrigins: sparseOrigins },
    })).rejects.toThrow('dense');
    await expect(fixture.assets.service('platform:target').fromBytes({
      bytes: 'outside', origin: { operation: 'platform-component', componentOrigins: [alpha] } as never,
    })).rejects.toThrow('only available during Platform finalization');
    scope.close();
    await expect(scope.service.fromBytes({ bytes: 'late', origin: { operation: 'late' } })).rejects.toThrow('no longer active');
  });

  it('rejects Component origins from another Platform or BuildSession', async () => {
    const current = await registries();
    const otherPlatform = current.assets.issueComponentOrigin('other', 'extension:private', 'private:resource');
    expect(() => current.assets.componentFinalizationScope(
      'target',
      'platform:target',
      [{ origin: otherPlatform }],
    )).toThrow('not authorized');

    const otherSession = await registries();
    const otherOrigin = otherSession.assets.issueComponentOrigin('target', 'extension:private', 'private:resource');
    expect(() => current.assets.componentFinalizationScope(
      'target',
      'platform:target',
      [{ origin: otherOrigin }],
    )).toThrow('not authorized');
  });

  it('creates SourceAsset refs and rejects forged, cross-owner, cross-session and expired refs', async () => {
    /** 当前测试独占的 Registry 集合。 */
    const fixture = await registries();
    /** 当前 owner 的来源目录 ref。 */
    const root = await fixture.sources.issueRoot('framework:canonical', fixture.sourceRoot);
    /** 当前 owner 的来源服务。 */
    const sources = fixture.sources.service('framework:canonical');
    /** 精确来源文件 ref。 */
    const source = await sources.file(root, 'source.txt');
    /** 来源 owner 的 Asset Service。 */
    const service = fixture.assets.service('framework:canonical');
    /** 从 SourceFileRef 签发的来源 Asset。 */
    const asset = await service.fromSource(source);
    /** 等形复制不在 WeakMap 中。 */
    const forged = Object.freeze({ ...asset }) as AssetRef;

    await expect(fixture.assets.service('platform:claude-code').read(asset)).rejects.toThrow('not authorized');
    await expect(service.read(forged)).rejects.toThrow('not authorized');
    fixture.assets.grant('framework:canonical', 'platform:claude-code', asset);
    await expect(fixture.assets.service('platform:claude-code').read(asset)).resolves.toEqual(expect.any(Uint8Array));
    expect(() => fixture.assets.grant('platform:claude-code', 'extension:other', asset)).toThrow('Only the Asset owner');

    /** 另一 BuildSession 的 Registry 即使收到原始对象也无记录。 */
    const otherScope = new BuildSessionScope();
    /** 另一 Session 的 Source Registry。 */
    const otherSources = new SourceRegistry(otherScope, fixture.root);
    /** 另一 Session 的 WorkDir Registry。 */
    const otherWork = new WorkDirectoryRegistry(otherScope, path.join(fixture.root, '.work-other'));
    /** 另一 Session 的 Asset Registry。 */
    const otherAssets = new AssetRegistry(otherScope, otherSources, otherWork);
    await expect(otherAssets.service('framework:canonical').read(asset)).rejects.toThrow('not authorized');

    fixture.scope.close();
    await expect(service.read(asset)).rejects.toThrow('no longer active');
  });

  it('detects SourceAsset mutation before read and materialization', async () => {
    /** 当前测试独占的 Registry 集合。 */
    const fixture = await registries();
    /** 当前 owner 的来源目录 ref。 */
    const root = await fixture.sources.issueRoot('framework:public', fixture.sourceRoot);
    /** 当前 owner 的精确来源文件 ref。 */
    const source = await fixture.sources.service('framework:public').file(root, 'source.txt');
    /** 当前 owner 的 SourceAsset。 */
    const asset = await fixture.assets.service('framework:public').fromSource(source);
    await fs.writeFile(path.join(fixture.sourceRoot, 'source.txt'), 'changed bytes\n');

    await expect(fixture.assets.service('framework:public').read(asset)).rejects.toThrow('changed after');
    await expect(fixture.assets.materializationBytes('framework:public', asset)).rejects.toThrow('changed after');
  });

  it('rejects source mutation between FileRef and SourceAsset issuance', async () => {
    /** 当前测试独占的 Registry 集合。 */
    const fixture = await registries();
    /** 当前 owner 的来源目录 ref。 */
    const root = await fixture.sources.issueRoot('framework:public', fixture.sourceRoot);
    /** 修改前签发的精确 SourceFileRef。 */
    const source = await fixture.sources.service('framework:public').file(root, 'source.txt');
    await fs.writeFile(path.join(fixture.sourceRoot, 'source.txt'), 'changed before asset\n');

    await expect(fixture.assets.service('framework:public').fromSource(source)).rejects.toThrow('changed after');
  });

  it('issues GeneratedAsset only from the owner workDir and preserves compile origin', async () => {
    /** 当前测试独占的 Registry 集合。 */
    const fixture = await registries();
    /** Compiler owner 的私有 workDir 句柄。 */
    const work = await fixture.work.directory('extension:mcp');
    /** 只有 Core Host 能获得的解析后生成路径。 */
    const output = fixture.work.resolve('extension:mcp', work, 'jobs/server/main.mjs');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, 'export default 1;\n');
    /** Compiler Host 签发的 GeneratedAsset。 */
    const asset = await fixture.assets.issueGenerated('extension:mcp', work, 'jobs/server/main.mjs', 0o755, {
      job: 'mcp-server',
      output: 'main',
      profile: 'portable-node',
      kind: 'chunk',
      inputs: ['src/mcp/server/server.ts', 'package:@scope/dependency@1.2.3/index.js', 'virtual:mcp-runner'],
    });
    /** 公开 metadata 保留稳定编译来源但没有 workDir。 */
    const description = fixture.assets.describe('extension:mcp', asset);

    expect(description.origin).toEqual({
      type: 'compile',
      owner: 'extension:mcp',
      job: 'mcp-server',
      output: 'main',
      profile: 'portable-node',
      kind: 'chunk',
      inputs: ['package:@scope/dependency@1.2.3/index.js', 'src/mcp/server/server.ts', 'virtual:mcp-runner'],
    });
    expect(JSON.stringify(description)).not.toContain(fixture.root);
    await fs.writeFile(output, 'mutated\n');
    await expect(fixture.assets.materializationBytes('extension:mcp', asset)).rejects.toThrow('changed after');
  });

  it('rejects invalid modes, origin text, read limits and workDir escapes', async () => {
    /** 当前测试独占的 Registry 集合。 */
    const fixture = await registries();
    /** 当前 owner 的闭包 Asset Service。 */
    const service = fixture.assets.service('extension:owned');
    await expect(service.fromBytes({ bytes: 'x', mode: 0o600 as never, origin: { operation: 'valid' } })).rejects.toThrow('0644 or 0755');
    await expect(service.fromBytes({ bytes: 'x', origin: { operation: '/absolute/path' } })).rejects.toThrow('stable lowercase');
    /** 合法 Asset 用于读取上限断言。 */
    const asset = await service.fromBytes({ bytes: 'abc', origin: { operation: 'valid' } });
    await expect(service.read(asset, { maxBytes: 2 })).rejects.toThrow('read limit');

    /** owner workDir 句柄不能被另一 owner 复用。 */
    const work = await fixture.work.directory('extension:a');
    expect(() => fixture.work.resolve('extension:b', work, 'main.mjs')).toThrow('not authorized');
    expect(() => fixture.work.resolve('extension:a', work, '../escape.mjs')).toThrow();
  });
});
