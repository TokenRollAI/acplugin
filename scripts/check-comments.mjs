import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

/** 中文注释至少需要包含一个中日韩统一表意文字。 */
const CHINESE_PATTERN = /[\u3400-\u9fff]/u;

/** 注释覆盖配置文件相对于仓库根目录的位置。 */
const COVERAGE_FILE = 'scripts/comment-coverage.json';

/**
 * 使用 UTF-16 code unit 比较路径，避免目录枚举结果受当前 locale 影响。
 *
 * @param left 左侧路径。
 * @param right 右侧路径。
 * @returns 与 Array.sort 约定一致的比较结果。
 */
function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
 * 读取声明绑定之前可见的中文说明，并兼容 `catch` 关键字后的绑定注释。
 *
 * @param source 当前文件对应的 TypeScript 语法树。
 * @param node 需要检查说明的声明节点。
 * @returns 声明前或 catch 异常绑定前的注释文本。
 */
function declarationComment(source, node) {
  /** 普通声明直接使用与节点相邻的前置注释。 */
  const leading = leadingComment(source, node);
  if (!ts.isCatchClause(node) || node.variableDeclaration === undefined)
    return leading;
  /** catch 关键字与异常变量之间允许放置的绑定专属注释。 */
  const bindingPrefix = source.getFullText().slice(node.getStart(source), node.variableDeclaration.getStart(source));
  return `${leading}\n${bindingPrefix}`;
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
 * 判断节点是否为需要中文解释的普通变量语句。
 *
 * @param node 待检查的变量语句。
 * @returns 任何函数体或模块中的 VariableStatement 都返回 true。
 */
function isVariableStatement(node) {
  return ts.isVariableStatement(node);
}

/**
 * 判断对象属性是否使用箭头函数或函数表达式定义可调用方法。
 *
 * @param node 待检查的对象属性节点。
 * @returns 属性值是 ArrowFunction 或 FunctionExpression 时返回 true。
 */
function isObjectFunctionProperty(node) {
  return ts.isPropertyAssignment(node)
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
}

/**
 * 收集单个文件中缺少中文前置说明的声明。
 *
 * @param file 相对于仓库根目录的源码路径。
 * @returns 可直接输出到终端的缺失项列表。
 */
function missingComments(file, displayFile = file) {
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
    const required = DECLARATION_KINDS.has(node.kind)
      || isVariableStatement(node)
      || isObjectFunctionProperty(node);
    if (required && !CHINESE_PATTERN.test(declarationComment(source, node))) {
      /** TypeScript 使用零基行列，需要转换为面向用户的一基行号。 */
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      missing.push(`${displayFile}:${line} ${declarationName(node)}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return missing;
}

/**
 * 返回一个目录的直属子目录；缺失目录按空集合处理。
 *
 * @param directory 待枚举目录。
 * @returns 按 code unit 排序的直属子目录绝对路径。
 */
function childDirectories(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(directory, entry.name))
      .sort(compareCodeUnits);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return [];
    throw error;
  }
}

/**
 * 枚举当前 monorepo 支持的三种 package 深度。
 *
 * @param root 待检查仓库根目录。
 * @returns 实际包含 package.json 的 package 根目录。
 */
function workspacePackageRoots(root) {
  /** 顶层、Platform 与 Extension 三类 package 候选。 */
  const candidates = [
    ...childDirectories(path.join(root, 'packages')),
    ...childDirectories(path.join(root, 'packages/platforms')),
    ...childDirectories(path.join(root, 'packages/extensions')),
  ];
  return candidates
    .filter(directory => existsSync(path.join(directory, 'package.json')))
    .sort(compareCodeUnits);
}

/**
 * 递归收集一个 package 直属 src 树中的 TypeScript 生产文件。
 *
 * @param directory 当前递归目录。
 * @returns 当前子树下按 code unit 排序的 .ts 文件绝对路径。
 */
function sourceFiles(directory) {
  if (!existsSync(directory))
    return [];
  /** 当前 src 子树累计发现的生产文件。 */
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name))) {
    /** 当前目录项的绝对路径。 */
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...sourceFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith('.ts'))
      files.push(candidate);
  }
  return files.sort(compareCodeUnits);
}

/**
 * 把绝对路径转换为覆盖清单使用的 POSIX 仓库相对路径。
 *
 * @param root 仓库根目录。
 * @param file 仓库内绝对文件路径。
 * @returns 不依赖宿主分隔符的清单路径。
 */
function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

/**
 * 解析测试夹具可覆盖的仓库根和 coverage 文件位置。
 *
 * @param args Node 入口之后的命令行参数。
 * @returns 绝对仓库根和 coverage 文件路径。
 */
function parseOptions(args) {
  /** 默认检查当前工作目录中的真实仓库。 */
  let root = process.cwd();
  /** 可选 coverage 路径先保留文本，最终相对 root 解析。 */
  let coverageFile = COVERAGE_FILE;
  for (let index = 0; index < args.length; index += 2) {
    /** 当前成对参数的选项名和值。 */
    const [flag, value] = args.slice(index, index + 2);
    if (value === undefined)
      throw new Error('Comment coverage options require a value.');
    if (flag === '--root')
      root = path.resolve(value);
    else if (flag === '--coverage')
      coverageFile = value;
    else
      throw new Error(`Unknown comment coverage option: ${flag}`);
  }
  return { root, coverageFile: path.resolve(root, coverageFile) };
}

/**
 * 执行已覆盖文件的中文注释检查，并以非零退出码阻止回退。
 */
function main() {
  /** 真实仓库或测试夹具提供的检查边界。 */
  const options = parseOptions(process.argv.slice(2));
  /** 注释覆盖配置，后续阶段通过扩展文件列表逐步收紧。 */
  const coverage = JSON.parse(readFileSync(options.coverageFile, 'utf8'));
  if (!Array.isArray(coverage.enforcedFiles) || coverage.enforcedFiles.some(file => typeof file !== 'string'))
    throw new Error('Comment coverage enforcedFiles must be an array of paths.');
  /** 去重后的显式覆盖路径集合。 */
  const enforced = new Set(coverage.enforcedFiles);
  /** 三种 package 深度下全部直属 src TypeScript 生产文件。 */
  const productionFiles = workspacePackageRoots(options.root)
    .flatMap(packageRoot => sourceFiles(path.join(packageRoot, 'src')))
    .map(file => relativePath(options.root, file))
    .sort(compareCodeUnits);
  /** 新增但尚未进入覆盖清单的生产文件。 */
  const uncovered = productionFiles.filter(file => !enforced.has(file));
  /** 清单中已经不存在的路径，避免删除/重命名后留下虚假覆盖。 */
  const stale = coverage.enforcedFiles.filter(file => !existsSync(path.join(options.root, file)));
  /** 重复清单项会让覆盖数量失真，应与漏项同样失败。 */
  const duplicated = coverage.enforcedFiles.filter((file, index) => coverage.enforcedFiles.indexOf(file) !== index);
  if (uncovered.length > 0 || stale.length > 0 || duplicated.length > 0) {
    if (uncovered.length > 0)
      process.stderr.write(`以下生产文件未加入中文注释覆盖：\n${uncovered.map(item => `- ${item}`).join('\n')}\n`);
    if (stale.length > 0)
      process.stderr.write(`以下中文注释覆盖路径不存在：\n${stale.map(item => `- ${item}`).join('\n')}\n`);
    if (duplicated.length > 0)
      process.stderr.write(`以下中文注释覆盖路径重复：\n${[...new Set(duplicated)].map(item => `- ${item}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  /** 所有已纳入强制覆盖范围的缺失项。 */
  const missing = coverage.enforcedFiles.flatMap(file => missingComments(path.join(options.root, file), file));
  if (missing.length > 0) {
    process.stderr.write(`以下声明缺少中文前置注释：\n${missing.map(item => `- ${item}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`中文注释守卫已覆盖 ${coverage.enforcedFiles.length} 个文件。\n`);
}

main();
