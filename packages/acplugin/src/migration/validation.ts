/** Migration 生成工程的正式 Core lifecycle 验证适配。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  defineConfig,
  runProject,
} from '../index.js';
import {
  defineExtension,
  definePlatform,
  stableJson,
  type Diagnostic,
  type PluginMetadata,
} from '@acplugin/core';
import { copyText } from './writers/shared.js';

/** 只在生成工程验证期间向临时 ESM 代理暴露真实公开 API 的全局键。 */
const MIGRATION_VALIDATION_API = Symbol.for('tokenroll.acplugin.migration-validation-api');

/** 并发 Migration 共享同一组不可变公开 API 时用于延迟删除全局桥接。 */
let activeValidationProxies = 0;

/**
 * 校验 Migration 生成的 plain MCP descriptor。
 *
 * 这不是正式 MCP Extension 的替代实现；它只证明 Migration 自己写出的 TypeScript
 * 可以由 Core Module Service 执行，正式语义仍由生成工程安装的官方 Extension 校验。
 *
 * @param definition Migration 生成源码提交的远程 HTTP 描述。
 */
function validateMigrationMcpServer(definition: unknown): void {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition))
    throw new TypeError('Migration MCP descriptor must export an object.');
  /** 原型约束阻止 Migration 产物借助类实例携带隐藏行为。 */
  const prototype = Object.getPrototypeOf(definition);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Migration MCP descriptor must export a plain object.');
  /** descriptor 的最小安全字段视图。 */
  const candidate = definition as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(candidate).length > 0
    || Object.values(Object.getOwnPropertyDescriptors(candidate)).some(descriptor => !('value' in descriptor)))
    throw new TypeError('Migration MCP descriptor must not use symbols or accessors.');
  if (candidate.transport !== 'http' || typeof candidate.url !== 'string')
    throw new TypeError('Migration MCP descriptor must use the remote HTTP transport.');
  /** Migration 只会自动生成无凭据的 HTTPS endpoint。 */
  const endpoint = new URL(candidate.url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
    throw new TypeError('Migration MCP descriptor must use a credential-free HTTPS URL.');
}

/** Migration 提交前验证使用的无产物 Platform，不包含任何官方 Platform 逻辑。 */
const migrationValidationPlatform = definePlatform({
  // Migration may preserve verified Claude-specific fields, so Scanner must see the target ID.
  id: 'claude-code',
  apiVersion: '1',
  deliveryType: 'plugin',
  /** Migration 验证使用完整 v2 Session，但不实现任何官方 Platform 转换。 */
  createSession: () => ({
    /** 只声明 Scanner 已接受的 Component 与 metadata，不产生候选 Asset。 */
    createPackage: ({ project }) => ({
      documents: [],
      assets: [],
      compatibility: [...project.commands, ...project.skills, ...project.agents].map(component => ({
        subject: `${component.kind}:${component.id}`,
        capability: 'component',
        level: 'native' as const,
        reason: 'The migration validation Platform accepts canonical resources.',
      })),
      metadata: [
        'name', 'version', 'description',
        ...(project.metadata.displayName === undefined ? [] : ['displayName']),
        ...(project.metadata.author === undefined
          ? []
          : [
              'author.name',
              ...(project.metadata.author.email === undefined ? [] : ['author.email']),
              ...(project.metadata.author.url === undefined ? [] : ['author.url']),
            ]),
        ...(project.metadata.homepage === undefined ? [] : ['homepage']),
        ...(project.metadata.repository === undefined ? [] : ['repository']),
        ...(project.metadata.license === undefined ? [] : ['license']),
        ...(project.metadata.keywords.length === 0 ? [] : ['keywords']),
      ].map(field => ({
        field,
        disposition: 'emitted' as const,
        output: `manifest/${field.replaceAll('.', '/')}`,
        reason: 'The migration validation Platform accepts this metadata field.',
      })),
    }),
    /** 使用固定主 Package 身份完成正式 lifecycle。 */
    finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
    /** Migration 私有 Platform 没有额外候选格式规则。 */
    validatePackage: () => undefined,
  }),
});

/** Migration 提交前执行自己生成的 MCP descriptor，并声明 mcp root 所有权。 */
const migrationValidationMcp = defineExtension({
  id: 'migration-validation-mcp',
  apiVersion: '1',
  resourceRoots: ['mcp'],
  /** 每轮验证创建隔离的 descriptor Module Session。 */
  createSession: () => ({
    /** 通过 v2 SourceRef/ModuleService fresh evaluate 每个生成 descriptor。 */
    async discover({ roots, sources, modules }) {
      /** 配置声明的 mcp root 是当前 Extension 唯一可读来源。 */
      const root = roots.mcp;
      if (root === undefined)
        return undefined;
      /** mcp root 只接受一层稳定 Server 目录。 */
      const entries = await sources.list(root);
      /** count 只用于证明所有 descriptor 均已通过执行验证。 */
      let count = 0;
      for (const entry of entries) {
        if (entry.type !== 'directory')
          throw new TypeError('Migration MCP entries must be directories.');
        /** 每个 Server 目录的固定作者入口。 */
        const descriptor = await sources.file(entry.directory, 'mcp.ts');
        /** 默认导出必须跨越正式 Module Host 数据边界。 */
        const value = await modules.loadDefault({ id: entry.name, entry: descriptor });
        validateMigrationMcpServer(value);
        count += 1;
      }
      return Object.freeze({ count });
    },
    /** Migration descriptor 没有 Platform delivery subject，只验证模块本身。 */
    validate: (_context, discovered) => ({ state: discovered, subjects: [] }),
    /** 无 Contributor 时 Core 会跳过 build；该方法只满足完整 Session contract。 */
    build: (_context, validated) => ({ state: validated }),
    contributors: [],
  }),
});

/** 临时代理读取的主包与 Migration 私有验证 API。 */
interface MigrationValidationApi {
  /** 生成配置使用的公开恒等辅助函数。 */
  readonly defineConfig: typeof defineConfig;
  /** 不生成产物、只驱动正式 Core Scanner 的 Migration 私有 Platform。 */
  readonly migrationValidationPlatform: typeof migrationValidationPlatform;
  /** 只通过 v2 Module Service 验证 Migration 生成 MCP descriptor 的私有 Extension。 */
  readonly migrationValidationMcp: typeof migrationValidationMcp;
}

/**
 * 用正式公开 API 加载并验证刚生成、尚未提交的规范工程。
 *
 * 生成工程尚未安装 package.json 依赖，因此验证期间创建只存在于 stage 的 ESM 代理。
 * 代理不实现任何规则，只把配置和 descriptor 导向当前进程已经加载的真实主包与 MCP
 * Extension；验证后整个 node_modules 会在提交前删除。
 *
 * @param outputRoot 单个迁移后规范工程的阶段目录。
 * @param usesMcp 工程是否需要正式 MCP Extension 参与 discover/validate。
 * @returns 公开 runProject() 返回的完整结构化诊断。
 */
export async function validateCanonicalProject(
  outputRoot: string,
  usesMcp: boolean,
  metadata: PluginMetadata,
): Promise<readonly Diagnostic[]> {
  /** 只供本次配置和 descriptor 加载解析包名的临时依赖根。 */
  const nodeModules = path.join(outputRoot, 'node_modules');
  /** 最终生成配置在验证期间由等价元数据的私有验证配置暂时替代。 */
  const configPath = path.join(outputRoot, 'acplugin.config.ts');
  /** 验证后必须恢复的最终用户配置文本。 */
  const generatedConfig = await fs.readFile(configPath, 'utf8');
  /** 全局桥接不暴露 Core Registry，也不引用或内联任何官方集成实现。 */
  const api: MigrationValidationApi = Object.freeze({
    defineConfig,
    migrationValidationPlatform,
    migrationValidationMcp,
  });
  Reflect.set(globalThis, MIGRATION_VALIDATION_API, api);
  activeValidationProxies += 1;
  try {
    /** 临时主包代理由生成的 acplugin.config.ts 正常按包名导入。 */
    const acpluginPackage = path.join(nodeModules, '@tokenroll/acplugin');
    await copyText(path.join(acpluginPackage, 'package.json'), stableJson({
      name: '@tokenroll/acplugin',
      version: '1.0.0',
      type: 'module',
      exports: './index.mjs',
    }));
    await copyText(path.join(acpluginPackage, 'index.mjs'), `
const api = globalThis[Symbol.for('tokenroll.acplugin.migration-validation-api')];
if (!api) throw new Error('Migration validation API is unavailable.');
export const defineConfig = api.defineConfig;
export const migrationValidationPlatform = api.migrationValidationPlatform;
export const migrationValidationMcp = api.migrationValidationMcp;
`);
    if (usesMcp) {
      /** 临时 MCP 包只为生成源码中的 type-only import 提供可解析包身份。 */
      const extensionPackage = path.join(nodeModules, '@tokenroll/acplugin-extension-mcp');
      await copyText(path.join(extensionPackage, 'package.json'), stableJson({
        name: '@tokenroll/acplugin-extension-mcp',
        version: '1.0.0',
        type: 'module',
        exports: './index.mjs',
      }));
      await copyText(path.join(extensionPackage, 'index.mjs'), 'export {};\n');
    }
    /** 用相同元数据驱动 Core Scanner；正式 Platform/Extension 在安装依赖后自行验证。 */
    await fs.writeFile(configPath, `
import {
  defineConfig,
  migrationValidationMcp,
  migrationValidationPlatform,
} from '@tokenroll/acplugin';

export default defineConfig({
  ...${stableJson(metadata).trim()},
  extensions: ${usesMcp ? '[migrationValidationMcp]' : '[]'},
  platforms: [migrationValidationPlatform],
  build: { strict: false },
});
`);
    /** 正式配置加载、Scanner、Extension 和全部配置 Platform validate 的公开结果。 */
    const result = await runProject({
      cwd: outputRoot,
      command: 'validate',
      mode: 'production',
      commit: false,
    });
    return result.diagnostics;
  } catch {
    /** 配置执行异常统一收敛为不携带路径、导出值或堆栈的迁移诊断。 */
    const diagnostics: readonly Diagnostic[] = Object.freeze([{
      code: 'MIGRATION_PROJECT_VALIDATION_FAILED',
      severity: 'error',
      phase: 'validate',
      message: 'The generated project could not be loaded and validated through the public API.',
    }]);
    return diagnostics;
  } finally {
    await fs.writeFile(configPath, generatedConfig);
    await fs.rm(nodeModules, { recursive: true, force: true });
    activeValidationProxies -= 1;
    if (activeValidationProxies === 0)
      Reflect.deleteProperty(globalThis, MIGRATION_VALIDATION_API);
  }
}
