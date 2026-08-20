/** 单个 Legacy ScanResult 的 canonical 工程写入编排。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stableJson, type Diagnostic } from '@acplugin/core';
import { publicPackageRange } from '../../ecosystem/versions.js';
import type { ScanResult } from '../legacy/types.js';
import {
  allocateMigrationIds,
  compareCodeUnits,
  ID_PATTERN,
  relative,
  safeId,
} from '../ids.js';
import { metadataFor } from '../metadata.js';
import type { MigrationFieldDraft, MigrationItem, MigrationOptions } from '../types.js';
import { validateCanonicalProject } from '../validation.js';
import { migrateAgent, migrateCommand, migrateSkill } from './components.js';
import { copyHookReference, hookReferenceCandidates } from './hooks.js';
import { redactedMcpServer, remoteMcpSource } from './mcp.js';
import {
  copyText,
  migrationItem,
  reportField,
  unmapped,
} from './shared.js';

/**
 * 把单个 Legacy ScanResult 写成完整规范工程，并用 Core Scanner 重新验证。
 *
 * Instructions、原始 Hooks、不安全 MCP 和未分类文件只进入 `.acplugin-migration/unmapped`，
 * 不会静默进入可发布 Plugin 内容。
 *
 * @param scan 旧工程或单个旧 Plugin 的扫描结果。
 * @param outputRoot 新规范工程的阶段目录。
 * @param options 迁移元数据和严格度选项。
 * @returns 资源迁移条目与规范工程重新扫描诊断。
 */
export async function writeCanonicalProject(
  scan: ScanResult,
  outputRoot: string,
  options: MigrationOptions,
): Promise<{ items: MigrationItem[]; diagnostics: readonly Diagnostic[] }> {
  /** 当前工程累计的资源迁移结论。 */
  const items: MigrationItem[] = [];
  /** 新工程最终使用的规范元数据。 */
  const metadata = await metadataFor(scan, options, items);
  // 即使旧来源只有未映射资源，也要保留合法的空 src 根以通过最终 Core 空状态校验。
  await fs.mkdir(path.join(outputRoot, 'src'), { recursive: true });
  /** 先整体分配 Skill ID，避免规范化冲突覆盖显式 ID 或依赖扫描顺序。 */
  const skills = allocateMigrationIds(scan.skills.map(skill => ({
    value: skill,
    baseId: safeId(skill.dirName),
    sourcePath: relative(scan.rootDir, skill.sourcePath),
  })));
  /** Command 使用独立 namespace，不与 Skill/Agent 的同名资源冲突。 */
  const commands = allocateMigrationIds(scan.commands.map(command => ({
    value: command,
    baseId: safeId(command.name),
    sourcePath: relative(scan.rootDir, command.sourcePath),
  })));
  /** Agent 使用独立 namespace，并在报告冻结前确定最终 destination。 */
  const agents = allocateMigrationIds(scan.agents.map(agent => ({
    value: agent,
    baseId: safeId(agent.fileName),
    sourcePath: relative(scan.rootDir, agent.sourcePath),
  })));
  /** Skills、Commands 与 Agents 的并行写入任务。 */
  const writes: Promise<void>[] = [];
  for (const skill of skills)
    writes.push(...migrateSkill(skill.value, skill.id, scan.rootDir, outputRoot, items));
  for (const command of commands)
    writes.push(migrateCommand(command.value, command.id, scan.rootDir, outputRoot, items));
  for (const agent of agents)
    writes.push(migrateAgent(agent.value, agent.id, scan.rootDir, outputRoot, items));
  await Promise.all(writes);

  for (const [index, instruction] of scan.instructions.entries()) {
    /** 当前越界 Instruction 的安全未映射保留路径。 */
    const destination = await unmapped(outputRoot, 'instructions', `${index}-${instruction.fileName}`, instruction.content);
    /** Instruction 原文所在的旧工程相对路径。 */
    const source = relative(scan.rootDir, instruction.sourcePath);
    items.push(migrationItem({ kind: 'instruction', id: instruction.fileName, source, destination }, [{
      field: 'content', source, destination, outcome: 'unmapped',
      reason: 'Instructions are outside the installable plugin boundary.',
    }]));
  }

  /** 是否至少自动迁移了一个安全远程 MCP，并需要启用官方 Extension。 */
  let usesMcp = false;
  /** 同一配置文件中的 MCP key 使用名称补充逻辑来源，确保排序和冲突消歧稳定。 */
  const mcpSourcePath = scan.mcp === null ? undefined : relative(scan.rootDir, scan.mcp?.sourcePath ?? scan.rootDir);
  /** MCP 使用自己的 namespace，显式 `foo-2` 不会被重复 `foo` 抢占。 */
  const servers = allocateMigrationIds((scan.mcp?.servers ?? []).map(server => ({
    value: server,
    baseId: safeId(server.name),
    sourcePath: `${mcpSourcePath ?? '.'}\0${server.name}`,
  })));
  for (const allocated of servers) {
    /** 当前已完成确定性 ID 分配的 Legacy MCP Server。 */
    const server = allocated.value;
    /** 当前 MCP namespace 中唯一的最终 ID。 */
    const id = allocated.id;
    /** 满足安全自动迁移条件时生成的类型化描述源码。 */
    const source = remoteMcpSource(server);
    /** MCP 字段报告共同使用的旧配置相对路径。 */
    const sourcePath = relative(scan.rootDir, scan.mcp!.sourcePath);
    if (source) {
      /** 自动迁移的远程 MCP 类型化描述文件路径。 */
      const destination = `src/mcp/${id}/mcp.ts`;
      await copyText(path.join(outputRoot, destination), source);
      /** 安全远程 MCP 的全部声明字段。 */
      const fields: MigrationFieldDraft[] = [];
      reportField(fields, 'name', sourcePath, ID_PATTERN.test(server.name) && server.name === id ? 'mapped' : 'degraded', ID_PATTERN.test(server.name) && server.name === id
        ? 'Server key maps directly to the canonical MCP ID.'
        : 'Server identity required lowercase kebab-case normalization or a deterministic collision suffix.');
      reportField(fields, 'transport', sourcePath, 'mapped', 'Remote HTTP transport maps to the canonical MCP descriptor.');
      reportField(fields, 'url', sourcePath, 'mapped', 'Credential-free HTTPS URL maps to the canonical MCP descriptor.');
      for (const name of Object.keys(server.headers ?? {}).sort(compareCodeUnits)) {
        reportField(fields, `headers.${name}`, sourcePath, 'mapped', name.toLowerCase() === 'authorization'
          ? 'Environment-only Authorization maps to canonical bearer auth without reading the secret.'
          : 'Environment-only header maps without reading the secret value.');
      }
      items.push(migrationItem({ kind: 'mcp', id, source: sourcePath, destination }, fields));
      usesMcp = true;
    } else {
      /** 无法自动迁移 MCP 的脱敏未映射记录路径。 */
      const destination = await unmapped(outputRoot, 'mcp', `${id}.json`, stableJson({ [server.name]: redactedMcpServer(server) }));
      /** 无法自动迁移的 MCP 仍逐个报告实际存在字段，且不复制任何值。 */
      const fields: MigrationFieldDraft[] = [];
      reportField(fields, 'name', sourcePath, ID_PATTERN.test(server.name) && server.name === id ? 'mapped' : 'degraded', ID_PATTERN.test(server.name) && server.name === id
        ? 'Server key maps to the migration record identity.'
        : 'Server identity required lowercase kebab-case normalization or a deterministic collision suffix.');
      for (const field of ['command', 'args', 'type', 'url'] as const) {
        if (server[field] !== undefined) {
          reportField(fields, field, sourcePath, 'unmapped', 'This MCP field requires a complete canonical implementation or a supported safe remote declaration.');
        }
      }
      for (const name of Object.keys(server.env ?? {}).sort(compareCodeUnits))
        reportField(fields, `env.${name}`, sourcePath, 'unmapped', 'Local MCP environment mapping is preserved only in the redacted sidecar.');
      for (const name of Object.keys(server.headers ?? {}).sort(compareCodeUnits))
        reportField(fields, `headers.${name}`, sourcePath, 'unmapped', 'Unsafe or literal MCP header is preserved only as a redacted field name.');
      items.push(migrationItem({ kind: 'mcp', id, source: sourcePath, destination }, fields));
    }
  }

  if (scan.hooks) {
    /** 原始 Hooks 配置的未映射保留路径。 */
    const destination = await unmapped(outputRoot, 'hooks', 'hooks.json', stableJson({ hooks: scan.hooks }));
    /** Legacy Scanner 保留的 Hooks 配置精确来源路径。 */
    const source = scan.hooksSourcePath === undefined ? '.' : relative(scan.rootDir, scan.hooksSourcePath);
    /** 每个旧事件分别进入字段报告，避免聚合配置掩盖丢失范围。 */
    const fields = Object.keys(scan.hooks).sort(compareCodeUnits).map<MigrationFieldDraft>(event => ({
      field: `event:${event}`, source, destination, outcome: 'unmapped',
      reason: 'Raw legacy Hook event requires manual typed handler migration.',
    }));
    items.push(migrationItem({ kind: 'hooks', id: 'hooks', source, destination }, fields));
    for (const reference of hookReferenceCandidates(scan.hooks))
      await copyHookReference(scan.rootDir, reference, outputRoot, items);
  }

  for (const file of scan.pluginFiles) {
    /** 当前未分类 Plugin 文件的隔离保留路径。 */
    const destination = await unmapped(outputRoot, 'plugin-files', file.relativePath, file.content);
    items.push(migrationItem({ kind: 'plugin-file', id: file.relativePath, source: file.relativePath, destination }, [{
      field: 'content', source: file.relativePath, destination, outcome: 'unmapped',
      reason: 'Unclassified plugin files are not published automatically.',
    }]));
  }

  /** 规范配置入口及按需追加的 Platform/Extension 导入。 */
  const imports = [
    `import { defineConfig } from '@tokenroll/acplugin';`,
    `import claudeCode from '@tokenroll/acplugin-platform-claude-code';`,
  ];
  if (usesMcp)
    imports.push(`import mcp from '@tokenroll/acplugin-extension-mcp';`);
  /** 按稳定顺序组成且只包含已知字段的最终配置行。 */
  const configLines = [
    'export default defineConfig({',
    `  name: ${JSON.stringify(metadata.name)},`,
    `  version: ${JSON.stringify(metadata.version)},`,
    `  description: ${JSON.stringify(metadata.description)},`,
  ];
  if (metadata.displayName !== undefined)
    configLines.push(`  displayName: ${JSON.stringify(metadata.displayName)},`);
  if (metadata.author !== undefined)
    configLines.push(`  author: ${JSON.stringify(metadata.author)},`);
  if (metadata.homepage !== undefined)
    configLines.push(`  homepage: ${JSON.stringify(metadata.homepage)},`);
  if (metadata.repository !== undefined)
    configLines.push(`  repository: ${JSON.stringify(metadata.repository)},`);
  if (metadata.license !== undefined)
    configLines.push(`  license: ${JSON.stringify(metadata.license)},`);
  if (metadata.keywords !== undefined)
    configLines.push(`  keywords: ${JSON.stringify(metadata.keywords)},`);
  if (usesMcp)
    configLines.push('  extensions: [mcp()],');
  configLines.push('  platforms: [claudeCode()],');
  configLines.push('  build: { strict: false },', '});');
  await copyText(path.join(outputRoot, 'acplugin.config.ts'), `${imports.join('\n')}\n\n${configLines.join('\n')}\n`);
  /** 新工程基础开发依赖及按需追加的官方 MCP Extension。 */
  const devDependencies: Record<string, string> = {
    '@tokenroll/acplugin': publicPackageRange('@tokenroll/acplugin'),
    '@tokenroll/acplugin-platform-claude-code': publicPackageRange('@tokenroll/acplugin-platform-claude-code'),
    'typescript': '^7.0.2',
    '@types/node': '^20.19.0',
  };
  if (usesMcp)
    devDependencies['@tokenroll/acplugin-extension-mcp'] = publicPackageRange('@tokenroll/acplugin-extension-mcp');
  await copyText(path.join(outputRoot, 'package.json'), stableJson({
    name: metadata.name,
    version: metadata.version,
    private: true,
    type: 'module',
    packageManager: 'pnpm@10.34.5',
    scripts: { validate: 'acplugin validate', inspect: 'acplugin inspect', build: 'acplugin build', typecheck: 'tsc --noEmit' },
    devDependencies,
  }));
  await copyText(path.join(outputRoot, 'tsconfig.json'), stableJson({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: ['node'], skipLibCheck: true }, include: ['acplugin.config.ts', 'src/**/*.ts'] }));
  await copyText(path.join(outputRoot, '.gitignore'), 'node_modules\ndist\n.acplugin-migration/unmapped/\n');

  // 只有正式公开 Pipeline 能证明生成配置与实际 Extension/Platform 契约共同成立。
  return { items, diagnostics: await validateCanonicalProject(outputRoot, usesMcp, metadata) };
}
