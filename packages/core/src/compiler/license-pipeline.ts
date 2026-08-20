import { promises as fs } from 'node:fs';
import path from 'node:path';
import parseSpdxExpression from 'spdx-expression-parse';
import { compareCodePoints } from '../security/path-policy.js';
import type { AuditedModule } from './managed/auditor.js';
import type { ManagedPackageScope } from './managed/boundary.js';

/** 单个法律材料文件的固定读取上限。 */
const MAX_LEGAL_FILE_BYTES = 4 * 1024 * 1024;

/** Core 认可的 package 根法律文件名。 */
const LEGAL_FILE = /^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/iu;

/** Compiler license pipeline 的确定性结果。 */
export interface CompilerLicenseResult {
  readonly bytes?: Uint8Array;
  readonly inputs: readonly string[];
  readonly watchFiles: readonly string[];
}

/**
 * 验证 manifest license 是完整 SPDX expression。
 *
 * @param value package.json license 字段。
 * @param identity 已脱敏 package 身份。
 * @returns 原始合法 expression。
 */
function spdxLicense(value: unknown, identity: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Bundled dependency "${identity}" must declare a license SPDX expression.`);
  try {
    parseSpdxExpression(value);
  } catch {
    throw new Error(`Bundled dependency "${identity}" declares an invalid license SPDX expression.`);
  }
  return value;
}

/**
 * 收集当前独立 entry 实际模块图中的第三方法律材料。
 *
 * @param modules 最终通过授权审计的模块图。
 * @param packages resolver 证明的 package 边界。
 * @returns 非空依赖时的固定文本和全部 watch/origin 输入。
 */
export async function collectCompilerLicenses(
  modules: readonly AuditedModule[],
  packages: ReadonlyMap<string, ManagedPackageScope>,
): Promise<CompilerLicenseResult> {
  /** 只收集确实进入最终 bundle graph 的 package root。 */
  const usedRoots = new Set(modules
    .filter(module => module.kind === 'package')
    .map(module => [...packages.values()].find(candidate => module.physicalId === candidate.root
      || module.physicalId.startsWith(`${candidate.root}${path.sep}`))?.root)
    .filter((root): root is string => root !== undefined));
  if (usedRoots.size === 0)
    return Object.freeze({ inputs: Object.freeze([]), watchFiles: Object.freeze([]) });
  /** package 身份排序不依赖包管理器物理布局。 */
  const dependencies = [...usedRoots]
    .map(root => packages.get(root)!)
    .sort((left, right) => compareCodePoints(`${left.name}@${left.version}`, `${right.name}@${right.version}`));
  /** 每个 package 独立形成一个稳定 section。 */
  const sections: string[] = [];
  /** manifest/legal 文件同时是 watch 和 structured origin 输入。 */
  const watchFiles: string[] = [];
  /** GeneratedAsset structured provenance 使用的安全 package 引用。 */
  const inputs: string[] = [];
  for (const dependency of dependencies) {
    /** package identity 不包含磁盘位置。 */
    const identity = `${dependency.name}@${dependency.version}`;
    /** 当前 package 根 manifest 物理路径。 */
    const manifestPath = path.join(dependency.root, 'package.json');
    /** resolver 已证明 manifest；license 阶段重新拒绝 symlink/特殊文件。 */
    const manifestStat = await fs.lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
      throw new Error(`Bundled dependency "${identity}" has an unsafe package manifest.`);
    /** JSON parse 错误统一收敛为不泄露绝对路径的诊断。 */
    let manifest: { readonly name?: unknown; readonly version?: unknown; readonly license?: unknown };
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as typeof manifest;
    } catch {
      throw new Error(`Bundled dependency "${identity}" has an unreadable package manifest.`);
    }
    if (manifest.name !== dependency.name || manifest.version !== dependency.version)
      throw new Error(`Bundled dependency "${identity}" changed identity during compilation.`);
    /** 经过 parser 完整确认的 SPDX expression。 */
    const license = spdxLicense(manifest.license, identity);
    /** 只枚举 package root，避免把嵌套源码中任意文件解释为法律材料。 */
    const directoryEntries = (await fs.readdir(dependency.root, { withFileTypes: true }))
      .filter(entry => LEGAL_FILE.test(entry.name))
      .sort((left, right) => compareCodePoints(left.name, right.name));
    if (directoryEntries.length === 0)
      throw new Error(`Bundled dependency "${identity}" does not contain license or notice evidence.`);
    /** 同一 package 的材料按文件名稳定连接。 */
    const materials: string[] = [];
    for (const entry of directoryEntries) {
      /** 当前法律材料的 package-root 直属物理路径。 */
      const legalPath = path.join(dependency.root, entry.name);
      /** 法律材料必须是普通非 symlink 文件且大小受限。 */
      const stat = await fs.lstat(legalPath);
      if (!entry.isFile() || !stat.isFile() || stat.isSymbolicLink())
        throw new Error(`Bundled dependency "${identity}" has unsafe legal material.`);
      if (stat.size === 0 || stat.size > MAX_LEGAL_FILE_BYTES)
        throw new Error(`Bundled dependency "${identity}" has missing or oversized legal material.`);
      /** CRLF 只规范成 LF；不裁剪或改写法律正文。 */
      const body = (await fs.readFile(legalPath, 'utf8')).replace(/\r\n?/gu, '\n');
      if (body.trim().length === 0)
        throw new Error(`Bundled dependency "${identity}" has empty legal material.`);
      materials.push(`--- ${entry.name} ---\n${body.endsWith('\n') ? body : `${body}\n`}`);
      watchFiles.push(legalPath);
      inputs.push(`package:${identity}/${entry.name}`);
    }
    watchFiles.push(manifestPath);
    inputs.push(`package:${identity}/package.json`);
    sections.push([
      `Package: ${identity}`,
      `License: ${license}`,
      '',
      ...materials,
    ].join('\n'));
  }
  /** 固定 heading/分隔与最终换行，不包含生成时间或物理路径。 */
  const text = `THIRD-PARTY LICENSES\n\n${sections.join('\n========================================\n\n')}`;
  return Object.freeze({
    bytes: new TextEncoder().encode(text.endsWith('\n') ? text : `${text}\n`),
    inputs: Object.freeze([...new Set(inputs)].sort(compareCodePoints)),
    watchFiles: Object.freeze([...new Set(watchFiles)].sort(compareCodePoints)),
  });
}
