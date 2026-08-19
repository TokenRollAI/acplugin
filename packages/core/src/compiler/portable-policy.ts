import { builtinModules } from 'node:module';
import path from 'node:path';
import type { ManagedRolldownPlugin } from '../kernel-types.js';
import type { ManagedEngine } from './engine-loader.js';

/** Node 当前 major 内全部 builtin 的非前缀规范名称。 */
const NODE_BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/u, '')));

/** portable-node 明确支持的作者 TS/JS 扩展名。 */
const PORTABLE_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * 把 Node builtin specifier 规范成唯一 `node:` 形式。
 *
 * @param source import/require specifier。
 * @returns 合法 builtin 的规范形式，否则 undefined。
 */
export function normalizeNodeBuiltin(source: string): string | undefined {
  /** node:test 等带子路径 builtin 也由 Node 列表精确决定。 */
  const name = source.replace(/^node:/u, '');
  return NODE_BUILTINS.has(name) ? `node:${name}` : undefined;
}

/**
 * 遍历 Oxc ESTree，拒绝需要运行时隐式解析的模块表达式。
 *
 * @param root Rolldown 精确版本 parser 返回的 AST。
 * @param label 不含物理绝对路径的模块标签。
 */
function auditPortableAst(root: unknown, label: string): void {
  /** 使用对象 identity 防止未来 AST 引入父指针时循环。 */
  const seen = new Set<object>();
  /** 深度优先检查所有普通 AST node/container。 */
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value))
      return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value)
        visit(item);
      return;
    }
    /** 只读取 parser 产生的 plain node data。 */
    const node = value as Record<string, unknown>;
    if (node.type === 'ImportExpression') {
      /** portable runtime 必须让 Rolldown 在构建时看见完整动态依赖。 */
      const source = node.source as Record<string, unknown> | undefined;
      if (source?.type !== 'Literal' || typeof source.value !== 'string')
        throw new Error(`Portable Node module "${label}" contains a non-literal dynamic import.`);
      if (/\.node(?:[?#]|$)/u.test(source.value))
        throw new Error(`Portable Node module "${label}" imports a native addon.`);
    }
    if (node.type === 'CallExpression') {
      /** CommonJS require 同样只允许静态单字符串参数。 */
      const callee = node.callee as Record<string, unknown> | undefined;
      if (callee?.type === 'Identifier' && callee.name === 'require') {
        /** require 的完整实参数组。 */
        const arguments_ = node.arguments as unknown[] | undefined;
        /** 唯一允许的首个字符串 Literal 参数。 */
        const first = arguments_?.[0] as Record<string, unknown> | undefined;
        if (arguments_?.length !== 1 || first?.type !== 'Literal' || typeof first.value !== 'string')
          throw new Error(`Portable Node module "${label}" contains a non-literal require.`);
        if (/\.node(?:[?#]|$)/u.test(first.value))
          throw new Error(`Portable Node module "${label}" imports a native addon.`);
      }
    }
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      /** 静态 import/export 的 source 若存在必须是普通字符串。 */
      const source = node.source as Record<string, unknown> | null | undefined;
      if (source !== null && source !== undefined
        && (source.type !== 'Literal' || typeof source.value !== 'string')) {
        throw new Error(`Portable Node module "${label}" contains an invalid static import.`);
      }
      if (typeof source?.value === 'string' && /\.node(?:[?#]|$)/u.test(source.value))
        throw new Error(`Portable Node module "${label}" imports a native addon.`);
    }
    if (node.type === 'NewExpression') {
      /** new URL(relative, import.meta.url) 会形成未纳入 Bundle/Asset graph 的隐式文件。 */
      const callee = node.callee as Record<string, unknown> | undefined;
      /** new URL 的完整实参数组。 */
      const arguments_ = node.arguments as unknown[] | undefined;
      /** 候选相对运行时文件参数。 */
      const first = arguments_?.[0] as Record<string, unknown> | undefined;
      /** 候选 import.meta.url 基准参数。 */
      const second = arguments_?.[1] as Record<string, unknown> | undefined;
      /** MemberExpression 的 import.meta object。 */
      const secondObject = second?.object as Record<string, unknown> | undefined;
      if (callee?.type === 'Identifier' && callee.name === 'URL'
        && first?.type === 'Literal' && typeof first.value === 'string'
        && (first.value.startsWith('./') || first.value.startsWith('../'))
        && second?.type === 'MemberExpression'
        && secondObject?.type === 'MetaProperty') {
        throw new Error(`Portable Node module "${label}" references an implicit runtime file.`);
      }
    }
    for (const child of Object.values(node))
      visit(child);
  };
  visit(root);
}

/**
 * 根据模块扩展名选择 Rolldown parser language。
 *
 * @param id Rolldown module ID。
 * @returns 需要审计的语言；JSON/虚拟 runtime helper 等返回 undefined。
 */
function portableLanguage(id: string): 'js' | 'jsx' | 'ts' | 'tsx' | undefined {
  /** query 不参与物理扩展名识别。 */
  const extension = path.extname(id.replace(/\?.*$/u, '')).toLowerCase();
  if (extension === '.ts' || extension === '.mts' || extension === '.cts')
    return 'ts';
  if (extension === '.tsx')
    return 'tsx';
  if (extension === '.jsx')
    return 'jsx';
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs')
    return 'js';
  /** Core virtual entries/modules没有文件扩展名，但作者格式固定为 JS/TS-ready ESM。 */
  if (id.startsWith('\0acplugin:'))
    return 'ts';
  return undefined;
}

/**
 * 建立 portable-node 的 builtin 规范化与源码语法策略 Plugin。
 *
 * 最终 module/output audit 仍在 Plugin 链之外执行；该 Plugin 只负责必须在
 * Rolldown 转换前观察的源语法和 builtin normalization。
 *
 * @param engine Core 唯一 Rolldown driver。
 * @returns 不暴露给调用方的固定 policy Plugin。
 */
export function portableNodePolicyPlugin(engine: ManagedEngine): ManagedRolldownPlugin {
  return Object.freeze({
    name: 'acplugin-portable-node-policy',
    /** bare 与 node: builtin 都规范为唯一 external identity。 */
    resolveId: {
      order: 'pre' as const,
      /** 规范 builtin 并在 resolver 前拒绝原生扩展。 */
      handler(source) {
        if (/\.node(?:[?#]|$)/u.test(source))
          throw new Error('Portable Node bundles must not contain native addons.');
        /** 当前 specifier 的可选规范 builtin identity。 */
        const builtin = normalizeNodeBuiltin(source);
        return builtin === undefined ? null : { id: builtin, external: true };
      },
    },
    /** 在 Rolldown TS transform 前拒绝无法完整打包的动态语义。 */
    transform: {
      order: 'pre' as const,
      /** 使用同一 Rolldown parser 审计转换前源语法。 */
      handler(code, id) {
        if (/\.node(?:[?#]|$)/u.test(id))
          throw new Error('Portable Node bundles must not contain native addons.');
        /** 当前模块可审计的 JS/TS parser language。 */
        const language = portableLanguage(id);
        if (language !== undefined)
          auditPortableAst(engine.parse(code, id, language), id.startsWith('\0') ? 'virtual' : path.basename(id));
        return null;
      },
    },
  });
}

/**
 * 验证 portable 作者入口使用受支持的源码扩展名。
 *
 * @param inputId 已解析的 source/virtual input ID。
 */
export function assertPortableEntryExtension(inputId: string): void {
  if (inputId.startsWith('\0acplugin:'))
    return;
  /** declaration file 即使以 .ts 结尾也不是可执行入口。 */
  const lower = inputId.toLowerCase();
  if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')
    || !PORTABLE_SOURCE_EXTENSIONS.has(path.extname(lower))) {
    throw new Error('Portable Node entries must use a supported executable TypeScript or JavaScript extension.');
  }
}
