import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CanonicalProject,
  CompilerService,
  ExecutionService,
  ExtensionSession,
  ModuleService,
  PlatformBasePackageSnapshot,
  PlatformIntegrationDescription,
} from '../../src/contracts/index.js';
import { defineExtension } from '../../src/api/definitions.js';
import { AssetRegistry } from '../../src/services/assets.js';
import { BuildSessionScope } from '../../src/services/session-scope.js';
import { DiagnosticRegistry } from '../../src/services/diagnostics.js';
import { SourceRegistry } from '../../src/services/sources.js';
import { WorkDirectoryRegistry } from '../../src/services/work-directories.js';
import {
  buildExtension,
  collectExtensionContributions,
  discoverExtension,
  preflightExtensionConsumers,
  validateExtension,
} from '../../src/resources/extensions.js';

/** Extension Provider 测试根。 */
const roots: string[] = [];

/** 空 canonical Project。 */
const project: CanonicalProject = Object.freeze({
  metadata: Object.freeze({ name: 'fixture', version: '1.0.0', description: 'Fixture.', keywords: Object.freeze([]) }),
  commands: Object.freeze([]), skills: Object.freeze([]), agents: Object.freeze([]), publicFiles: Object.freeze([]),
});

/** 测试不调用 Module Host 的类型完备 service。 */
const modules: ModuleService = Object.freeze({
  loadDefault: async <T>() => undefined as T,
});

/** 测试 Extension 不调用 Compiler Host 的类型完备 service。 */
const compiler: CompilerService = Object.freeze({
  engine: Object.freeze({ name: 'rolldown', version: 'test' }),
  compile: async () => { throw new Error('Compiler should not be called by this fixture.'); },
});

/** 测试 Extension 不调用 Execution Host 的类型完备 service。 */
const execution: ExecutionService = Object.freeze({
  runNode: async () => { throw new Error('Execution should not be called by this fixture.'); },
});

/** 选中目标 Platform 的稳定公开 description。 */
const targetPlatform: PlatformIntegrationDescription = Object.freeze({
  kind: 'platform', id: 'target', apiVersion: '1', options: Object.freeze({}), capabilities: Object.freeze({}),
});

/** Contributor 共享读取的最小 base Package。 */
const base: PlatformBasePackageSnapshot = Object.freeze({
  documents: Object.freeze([]), assets: Object.freeze([]), compatibility: Object.freeze([]), metadata: Object.freeze([]),
});

/**
 * 创建 owner-scoped Extension Provider fixture。
 *
 * @returns refs、registries 和通用调用参数。
 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-extension-provider-'));
  roots.push(root);
  const resource = path.join(root, 'src', 'owned');
  await fs.mkdir(resource, { recursive: true });
  await fs.writeFile(path.join(resource, 'descriptor.ts'), 'export default {};\n');
  const scope = new BuildSessionScope();
  const sources = new SourceRegistry(scope, root);
  const work = new WorkDirectoryRegistry(scope, path.join(root, '.work'));
  const assets = new AssetRegistry(scope, sources, work);
  const diagnostics = new DiagnosticRegistry();
  const owner = 'extension:owned';
  const rootRef = await sources.issueRoot(owner, resource);
  const file = await sources.service(owner).file(rootRef, 'descriptor.ts');
  const asset = await assets.service(owner).fromSource(file);
  const extension = defineExtension({
    id: 'owned', apiVersion: '1', resourceRoots: ['owned'],
    createSession: () => { throw new Error('test supplies session directly'); },
  });
  return { root, owner, sources, assets, diagnostics, rootRef, file, asset, extension };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Extension Provider state boundaries', () => {
  it('copies discovered/validated state while preserving authorized ref identity and sorting subjects', async () => {
    const current = await fixture();
    const mutable = { list: ['original'] };
    const session: ExtensionSession<unknown, unknown, unknown> = {
      discover: () => ({ mutable, file: current.file, asset: current.asset }),
      validate: (_context, discovered) => ({
        state: { discovered, enabled: true },
        subjects: [
          { subject: 'hook:zeta', capabilities: ['wire', 'runtime'] },
          { subject: 'hook:alpha', capabilities: ['runtime'] },
        ],
      }),
      build: () => ({ state: {} }),
      contributors: [],
    };
    const discovered = await discoverExtension({
      extension: current.extension,
      session,
      roots: { owned: current.rootRef },
      command: 'build', mode: 'production',
      sources: current.sources,
      assets: current.assets,
      modules,
      diagnostics: current.diagnostics,
    });
    mutable.list.push('changed');
    expect(discovered?.state).toMatchObject({ mutable: { list: ['original'] }, file: current.file, asset: current.asset });
    expect(Object.isFrozen((discovered?.state as { mutable: object }).mutable)).toBe(true);
    const validated = await validateExtension({
      discovered: discovered!, session, project, command: 'build', mode: 'production',
      sources: current.sources, assets: current.assets, diagnostics: current.diagnostics,
    });
    expect(validated.subjects).toEqual([
      { subject: 'hook:alpha', capabilities: ['runtime'] },
      { subject: 'hook:zeta', capabilities: ['runtime', 'wire'] },
    ]);
    expect(Object.isFrozen(validated.state)).toBe(true);
  });

  it('rejects functions, accessors, cycles, classes and forged refs in discovered state', async () => {
    const check = async (state: unknown, expected: string): Promise<void> => {
      const current = await fixture();
      const session: ExtensionSession<unknown, unknown, unknown> = {
        discover: () => state,
        validate: () => ({ state: {}, subjects: [] }),
        build: () => ({ state: {} }),
        contributors: [],
      };
      await expect(discoverExtension({
        extension: current.extension,
        session,
        roots: { owned: current.rootRef },
        command: 'build', mode: 'production', sources: current.sources, assets: current.assets,
        modules, diagnostics: current.diagnostics,
      })).rejects.toThrow(expected);
    };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    class State {}
    const accessor = Object.defineProperty({}, 'value', { get: () => 'hidden', enumerable: true });
    const current = await fixture();

    await check({ run: () => undefined }, 'unsupported');
    await check(accessor, 'data property');
    await check(cycle, 'cycle');
    await check(new State(), 'plain objects');
    await check({ file: Object.freeze({ ...current.file }) }, 'unauthorized SourceRef');
  });

  it('rejects malformed and duplicate validation subjects', async () => {
    const current = await fixture();
    const session: ExtensionSession<unknown, unknown, unknown> = {
      discover: () => ({}),
      validate: () => ({
        state: {},
        subjects: [
          { subject: 'duplicate', capabilities: ['runtime'] },
          { subject: 'duplicate', capabilities: ['runtime'] },
        ],
      }),
      build: () => ({ state: {} }),
      contributors: [],
    };
    const discovered = await discoverExtension({
      extension: current.extension, session, roots: { owned: current.rootRef }, command: 'build', mode: 'production',
      sources: current.sources, assets: current.assets,
      modules, diagnostics: current.diagnostics,
    });
    await expect(validateExtension({
      discovered: discovered!, session, project, command: 'build', mode: 'production',
      sources: current.sources, assets: current.assets, diagnostics: current.diagnostics,
    })).rejects.toThrow('duplicated');
  });

  it('preflights consumers, skips unused builds and creates explicit unsupported compatibility', async () => {
    const current = await fixture();
    let builds = 0;
    const session: ExtensionSession<unknown, unknown, unknown> = {
      discover: () => ({}),
      validate: () => ({ state: {}, subjects: [{ subject: 'hook:check', capabilities: ['runtime', 'wire'] }] }),
      build: () => {
        builds += 1;
        return { state: {} };
      },
      contributors: [],
    };
    const discovered = await discoverExtension({
      extension: current.extension, session, roots: { owned: current.rootRef }, command: 'build', mode: 'production',
      sources: current.sources, assets: current.assets, modules, diagnostics: current.diagnostics,
    });
    const validated = await validateExtension({
      discovered: discovered!, session, project, command: 'build', mode: 'production',
      sources: current.sources, assets: current.assets, diagnostics: current.diagnostics,
    });
    const plan = preflightExtensionConsumers({ validated, session, platforms: [targetPlatform] });
    const built = await buildExtension({
      plan, session, project, command: 'build', mode: 'production', compiler, execution,
      sources: current.sources, assets: current.assets, diagnostics: current.diagnostics,
    });
    const contributions = await collectExtensionContributions({
      platform: targetPlatform, base, project, command: 'build', mode: 'production',
      plans: [plan], built: [], assets: current.assets, diagnostics: current.diagnostics,
    });

    expect(plan.requiresBuild).toBe(false);
    expect(builds).toBe(0);
    expect(built).toBeUndefined();
    expect(contributions[0]?.contribution.compatibility).toEqual([
      expect.objectContaining({ subject: 'hook:check', capability: 'runtime', level: 'unsupported' }),
      expect.objectContaining({ subject: 'hook:check', capability: 'wire', level: 'unsupported' }),
    ]);
  });

  it('builds once for matching consumers and passes one immutable base to the Contributor', async () => {
    const current = await fixture();
    let receivedBase: PlatformBasePackageSnapshot | undefined;
    let builds = 0;
    const session: ExtensionSession<unknown, { readonly asset: typeof current.asset }, { readonly asset: typeof current.asset }> = {
      discover: () => ({}),
      validate: () => ({ state: { asset: current.asset }, subjects: [{ subject: 'hook:check', capabilities: ['runtime'] }] }),
      build: (_context, validated) => {
        builds += 1;
        return { state: { asset: validated.asset } };
      },
      contributors: [{
        platform: 'target', platformApiVersion: '1',
        contribute: (context, built) => {
          receivedBase = context.base;
          return {
            assets: [{ path: 'runtime/hook.mjs', asset: built.asset }],
            compatibility: [{ subject: 'hook:check', capability: 'runtime', level: 'native', reason: 'Native.' }],
          };
        },
      }],
    };
    const discovered = await discoverExtension({
      extension: current.extension, session, roots: { owned: current.rootRef }, command: 'build', mode: 'production',
      sources: current.sources, assets: current.assets, modules, diagnostics: current.diagnostics,
    });
    const validated = await validateExtension({
      discovered: discovered!, session, project, command: 'build', mode: 'production',
      sources: current.sources, assets: current.assets, diagnostics: current.diagnostics,
    });
    const plan = preflightExtensionConsumers({ validated, session, platforms: [targetPlatform] });
    const built = await buildExtension({
      plan, session, project, command: 'build', mode: 'production', compiler, execution,
      sources: current.sources, assets: current.assets, diagnostics: current.diagnostics,
    });
    const contributions = await collectExtensionContributions({
      platform: targetPlatform, base, project, command: 'build', mode: 'production',
      plans: [plan], built: [built!], assets: current.assets, diagnostics: current.diagnostics,
    });

    expect(plan.requiresBuild).toBe(true);
    expect(builds).toBe(1);
    expect(receivedBase).toBe(base);
    expect(Object.isFrozen(built?.state)).toBe(true);
    expect(contributions[0]).toMatchObject({ owner: 'extension:owned', subjects: [{ subject: 'hook:check' }] });
  });

  it('rejects duplicate, wrong-version and accessor Contributor definitions during preflight', async () => {
    const current = await fixture();
    const validated = Object.freeze({ extension: current.extension, state: Object.freeze({}), subjects: Object.freeze([]) });
    const contributor = Object.freeze({
      platform: 'target', platformApiVersion: '1' as const,
      contribute: () => ({ compatibility: [] }),
    });
    const session = (contributors: readonly unknown[]): ExtensionSession<unknown, unknown, unknown> => ({
      discover: () => ({}), validate: () => ({ state: {}, subjects: [] }), build: () => ({ state: {} }),
      contributors: contributors as never,
    });

    expect(() => preflightExtensionConsumers({ validated, session: session([contributor, contributor]), platforms: [targetPlatform] })).toThrow('duplicate');
    expect(() => preflightExtensionConsumers({
      validated, session: session([{ ...contributor, platformApiVersion: '2' }]), platforms: [targetPlatform],
    })).toThrow('API version 1');
    expect(() => preflightExtensionConsumers({
      validated,
      session: session([Object.defineProperty({ platformApiVersion: '1', contribute: () => ({ compatibility: [] }) }, 'platform', {
        get: () => 'target', enumerable: true,
      })]),
      platforms: [targetPlatform],
    })).toThrow('data property');
  });
});
