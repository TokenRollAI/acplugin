import { publicPackageRange } from '../ecosystem/versions.js';
import type { InitPlatformId } from './prompts.js';

/** 每个独立版本化官方 Platform 的 package、配置工厂导出名与脚手架依赖范围。 */
const PLATFORM_PACKAGES: Readonly<Record<InitPlatformId, { packageName: string; factory: string; version: string }>> = {
  'claude-code': { packageName: '@tokenroll/acplugin-platform-claude-code', factory: 'claudeCode', version: publicPackageRange('@tokenroll/acplugin-platform-claude-code') },
  'codex': { packageName: '@tokenroll/acplugin-platform-codex', factory: 'codex', version: publicPackageRange('@tokenroll/acplugin-platform-codex') },
  'cursor': { packageName: '@tokenroll/acplugin-platform-cursor', factory: 'cursor', version: publicPackageRange('@tokenroll/acplugin-platform-cursor') },
  'antigravity': { packageName: '@tokenroll/acplugin-platform-antigravity', factory: 'antigravity', version: publicPackageRange('@tokenroll/acplugin-platform-antigravity') },
  'opencode': { packageName: '@tokenroll/acplugin-platform-opencode', factory: 'openCode', version: publicPackageRange('@tokenroll/acplugin-platform-opencode') },
  'pi': { packageName: '@tokenroll/acplugin-platform-pi', factory: 'pi', version: publicPackageRange('@tokenroll/acplugin-platform-pi') },
};

/** 单个确定性脚手架文件及其工程相对内容。 */
export interface ScaffoldTemplate {
  readonly path: string;
  readonly content: string;
}

/** 模板生成所需的已验证输入。 */
export interface ScaffoldTemplateOptions {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly platforms: readonly InitPlatformId[];
  readonly hooks: boolean;
  readonly mcp: boolean;
  readonly nodeRuntime: boolean;
}

/** @returns 值是否为脚手架支持的官方 Platform ID。 */
export function isInitPlatformId(value: string): value is InitPlatformId {
  return Object.hasOwn(PLATFORM_PACKAGES, value);
}

/** 生成使用顶层元数据和可选官方 Extension 的 `acplugin.config.ts`。 */
function configSource(metadata: ScaffoldTemplateOptions): string {
  /** 配置入口以及每个选中 Platform 的独立 package 默认导入。 */
  const imports = [
    `import { defineConfig } from '@tokenroll/acplugin';`,
    ...metadata.platforms.map((platform) => {
      /** 当前官方 Platform 的 package 名和本地工厂名。 */
      const definition = PLATFORM_PACKAGES[platform];
      return `import ${definition.factory} from '${definition.packageName}';`;
    }),
  ];
  /** 写入配置 `extensions` 数组的初始化表达式。 */
  const extensions: string[] = [];
  if (metadata.hooks) {
    imports.push(`import hooks from '@tokenroll/acplugin-extension-hooks';`);
    extensions.push('hooks()');
  }
  if (metadata.mcp) {
    imports.push(`import mcp from '@tokenroll/acplugin-extension-mcp';`);
    extensions.push('mcp()');
  }
  return `${imports.join('\n')}

export default defineConfig({
  name: ${JSON.stringify(metadata.name)},
  version: '0.1.0',
  description: ${JSON.stringify(metadata.description)},
  displayName: ${JSON.stringify(metadata.displayName)},
  platforms: [${metadata.platforms.map(platform => `${PLATFORM_PACKAGES[platform].factory}()`).join(', ')}],${extensions.length
    ? `
  extensions: [${extensions.join(', ')}],`
    : ''}
});
`;
}

/** 生成仅包含工程开发依赖和标准命令的私有 package.json。 */
function packageSource(options: ScaffoldTemplateOptions): string {
  /** 根据 Extension 选择动态扩展的开发依赖映射。 */
  const devDependencies: Record<string, string> = {
    '@tokenroll/acplugin': publicPackageRange('@tokenroll/acplugin'),
    '@types/node': '^20.19.0',
    'typescript': '^7.0.2',
  };
  for (const platform of options.platforms) {
    /** 官方 Platform 独立发布后由自身元数据决定脚手架依赖范围。 */
    const definition = PLATFORM_PACKAGES[platform];
    devDependencies[definition.packageName] = definition.version;
  }
  if (options.hooks)
    devDependencies['@tokenroll/acplugin-extension-hooks'] = publicPackageRange('@tokenroll/acplugin-extension-hooks');
  if (options.mcp)
    devDependencies['@tokenroll/acplugin-extension-mcp'] = publicPackageRange('@tokenroll/acplugin-extension-mcp');
  return `${JSON.stringify({
    name: options.name,
    version: '0.1.0',
    private: true,
    type: 'module',
    packageManager: 'pnpm@10.34.5',
    engines: { node: '^20.19.0 || ^22.13.0 || >=23.5.0' },
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

/** @returns 与旧 init 完全相同顺序和字节的全部脚手架模板。 */
export function createScaffoldTemplates(options: ScaffoldTemplateOptions): readonly ScaffoldTemplate[] {
  return Object.freeze([
    Object.freeze({ path: 'acplugin.config.ts', content: configSource(options) }),
    Object.freeze({ path: 'package.json', content: packageSource(options) }),
    Object.freeze({
      path: 'tsconfig.json',
      content: `${JSON.stringify({
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
      }, null, 2)}\n`,
    }),
    Object.freeze({ path: '.gitignore', content: 'node_modules\ndist\n' }),
    Object.freeze({
      path: `src/skills/${options.name}/SKILL.md`,
      content: `---
description: Describe when and why to use ${options.displayName}.
---
Replace this text with the focused workflow ${options.displayName} should perform.
`,
    }),
    ...(options.nodeRuntime
      ? [Object.freeze({
          path: 'src/runtime/main.ts',
          content: `import process from 'node:process';

process.stdout.write('ACPlugin Node runtime is ready.\\n');
`,
        })]
      : []),
  ]);
}
