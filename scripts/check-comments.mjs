import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

/** 中文注释至少需要包含一个中日韩统一表意文字。 */
const CHINESE_PATTERN = /[\u3400-\u9fff]/u;

/** 注释覆盖配置文件相对于仓库根目录的位置。 */
const COVERAGE_FILE = 'scripts/comment-coverage.json';

/** 需要前置中文说明的声明节点类型。 */
const DECLARATION_KINDS = new Set([
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.TypeAliasDeclaration,
]);

/**
 * 读取声明节点前的全部注释文本。
 *
 * @param source 当前文件对应的 TypeScript 语法树。
 * @param node 需要检查前置注释的声明节点。
 * @returns 与声明直接相邻的前置注释文本。
 */
function leadingComment(source, node) {
  /** 当前源码的完整文本，用于按字符区间提取注释。 */
  const text = source.getFullText();
  /** TypeScript 解析器识别到的前置注释字符区间。 */
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  return ranges.map(range => text.slice(range.pos, range.end)).join('\n');
}

/**
 * 返回便于诊断的声明名称，匿名声明使用语法类型代替。
 *
 * @param node 待描述的声明节点。
 * @returns 稳定且便于定位的声明名称。
 */
function declarationName(node) {
  /** 声明节点可能携带的标识符名称。 */
  const name = 'name' in node ? node.name : undefined;
  if (name && ts.isIdentifier(name))
    return name.text;
  if (ts.isConstructorDeclaration(node))
    return 'constructor';
  return ts.SyntaxKind[node.kind];
}

/**
 * 判断变量语句是否位于模块顶层。
 *
 * @param node 待检查的变量语句。
 * @returns 位于 SourceFile 直接子级时返回 true。
 */
function isModuleVariable(node) {
  return ts.isVariableStatement(node) && ts.isSourceFile(node.parent);
}

/**
 * 收集单个文件中缺少中文前置说明的声明。
 *
 * @param file 相对于仓库根目录的源码路径。
 * @returns 可直接输出到终端的缺失项列表。
 */
function missingComments(file) {
  /** 文件的原始源码内容。 */
  const text = readFileSync(file, 'utf8');
  /** 用于定位声明和注释区间的 TypeScript 语法树。 */
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  /** 当前文件累计发现的注释缺失项。 */
  const missing = [];

  /**
   * 递归访问语法树，并检查受规则约束的声明节点。
   *
   * @param node 当前访问的语法树节点。
   */
  function visit(node) {
    /** 标记节点是否属于需要中文前置注释的声明范围。 */
    const required = DECLARATION_KINDS.has(node.kind) || isModuleVariable(node);
    if (required && !CHINESE_PATTERN.test(leadingComment(source, node))) {
      /** TypeScript 使用零基行列，需要转换为面向用户的一基行号。 */
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      missing.push(`${file}:${line} ${declarationName(node)}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return missing;
}

/**
 * 执行已覆盖文件的中文注释检查，并以非零退出码阻止回退。
 */
function main() {
  /** 注释覆盖配置，后续阶段通过扩展文件列表逐步收紧。 */
  const coverage = JSON.parse(readFileSync(COVERAGE_FILE, 'utf8'));
  /** 所有已纳入强制覆盖范围的缺失项。 */
  const missing = coverage.enforcedFiles.flatMap(file => missingComments(path.normalize(file)));
  if (missing.length > 0) {
    process.stderr.write(`以下声明缺少中文前置注释：\n${missing.map(item => `- ${item}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`中文注释守卫已覆盖 ${coverage.enforcedFiles.length} 个文件。\n`);
}

main();
