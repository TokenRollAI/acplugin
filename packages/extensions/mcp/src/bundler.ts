import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { build as rolldownBuild, type OutputChunk } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import type { ExtensionBuildContext } from '@tokenroll/acplugin';
import type { DiscoveredMcpServer, DiscoveredMcpServers } from './discovery.js';

/** 单个 stdio MCP Server 的独立可执行文件与许可文件。 */
export interface BundledMcpServer {
  /** Rolldown 生成的单文件 Node 20 ESM Server 路径。 */
  readonly server: string;
  /** Bundle 包含第三方依赖时生成的合并许可文件。 */
  readonly licenses?: string;
}

/** Adapter 读取的一个已验证 MCP Server 与可选本地 Bundle。 */
export interface BuiltMcpServer {
  /** 规范 Server ID。 */
  readonly id: string;
  /** 已通过验证的作者定义。 */
  readonly definition: DiscoveredMcpServer['definition'];
  /** stdio Server 的平台中立 Bundle；HTTP Server 不包含此字段。 */
  readonly bundle?: BundledMcpServer;
}

/** build 阶段交给所有 Platform Adapter 的平台中立状态。 */
export interface BuiltMcpServers {
  /** 按 Server ID 稳定排序且每个 stdio 实现只 Bundle 一次的列表。 */
  readonly servers: readonly BuiltMcpServer[];
}

/** Bundle 中一个第三方 npm 包的许可元数据与原始法律文本。 */
interface PackageLicense {
  /** npm 包名。 */
  readonly name: string;
  /** npm 包版本。 */
  readonly version: string;
  /** package.json 声明的 SPDX 表达式或 UNKNOWN。 */
  readonly license: string;
  /** 包根目录中发现的 LICENSE 或 NOTICE 文件。 */
  readonly notices: readonly { readonly name: string; readonly text: string }[];
}

/** 构建期 stdio 协议探测对外只暴露的脱敏失败类别。 */
type McpSmokeFailure = 'output-limit' | 'process-exit' | 'protocol' | 'spawn' | 'timeout';

/** MCP smoke 允许 Server 写入 stdout/stderr 的合计字节上限。 */
const MCP_SMOKE_OUTPUT_LIMIT = 256 * 1024;

/** MCP smoke 等待 initialize 与 tools/list 的总时限。 */
const MCP_SMOKE_TIMEOUT_MS = 5_000;

/**
 * 从 Rolldown Module ID 向上查找所属 npm 包及其许可文件。
 *
 * @param moduleId Bundle 图中的原始 Module ID。
 * @returns 第三方 node_modules 文件对应的许可记录；工程源码返回 undefined。
 */
async function packageLicenseForModule(moduleId: string): Promise<PackageLicense | undefined> {
  /** 移除 Rolldown 查询参数和虚拟模块前缀后的文件路径。 */
  const normalized = moduleId.replace(/\?.*$/u, '').replace(/^\0/u, '');
  if (!normalized.includes(`${path.sep}node_modules${path.sep}`))
    return undefined;
  /** 从模块文件开始向上查找 package.json 的当前目录。 */
  let directory = path.dirname(normalized);
  /** 终止向上遍历的文件系统根目录。 */
  const root = path.parse(directory).root;
  while (directory !== root) {
    try {
      /** 当前候选目录中的包清单。 */
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')) as {
        readonly name?: unknown;
        readonly version?: unknown;
        readonly license?: unknown;
      };
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        /** 包根目录的一级文件，用于发现法律文本。 */
        const entries = await fs.readdir(directory, { withFileTypes: true });
        /** 按稳定顺序保留的 LICENSE 与 NOTICE 文件名。 */
        const noticeFiles = entries
          .filter(entry => entry.isFile() && /^(?:licen[cs]e|notice)(?:\..*)?$/iu.test(entry.name))
          .map(entry => entry.name)
          .sort((left, right) => left.localeCompare(right, 'en'));
        if (noticeFiles.length === 0)
          throw new Error(`Bundled dependency ${manifest.name}@${manifest.version} has no license or notice file.`);
        return {
          name: manifest.name,
          version: manifest.version,
          license: typeof manifest.license === 'string' ? manifest.license : 'UNKNOWN',
          notices: await Promise.all(noticeFiles.map(async (name) => {
            /** 当前第三方法律文件的完整文本。 */
            const text = (await fs.readFile(path.join(directory, name), 'utf8')).trimEnd();
            return Object.freeze({ name, text });
          })),
        };
      }
    } catch /** error 保存当前许可元数据读取失败，供 ENOENT 分支判断。 */ (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot resolve package metadata for bundled module ${path.basename(normalized)}.`);
}

/**
 * 汇总 Bundle 实际包含的第三方包许可，并写入稳定文本文件。
 *
 * @param chunk 唯一的 Rolldown 输出 Chunk。
 * @param directory Server Bundle 所在目录。
 * @returns 存在第三方依赖时返回许可文件路径，否则返回 undefined。
 */
async function writeThirdPartyLicenses(chunk: OutputChunk, directory: string): Promise<string | undefined> {
  /** 按包名和版本去重的许可记录。 */
  const records = new Map<string, PackageLicense>();
  /** moduleId 表示当前 Bundle Module，用于追溯第三方许可。 */
  for (const moduleId of Object.keys(chunk.modules).sort((left, right) => left.localeCompare(right, 'en'))) {
    /** 当前 Bundle Module 所属的可选第三方包许可。 */
    const record = await packageLicenseForModule(moduleId);
    if (record !== undefined)
      records.set(`${record.name}@${record.version}`, record);
  }
  if (records.size === 0)
    return undefined;
  /** 按确定顺序拼接的许可文件段落。 */
  const sections = ['THIRD-PARTY LICENSES'];
  /** [id, record] 表示当前许可记录，用于输出稳定法律文本。 */
  for (const [id, record] of [...records].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    sections.push(`## ${id}\nSPDX: ${record.license}`);
    /** notice 表示当前包的一个 LICENSE 或 NOTICE 文件。 */
    for (const notice of record.notices)
      sections.push(`### ${notice.name}\n${notice.text}`);
  }
  /** 与 Server 一同发布的第三方许可文件路径。 */
  const destination = path.join(directory, 'THIRD_PARTY_LICENSES.txt');
  await fs.writeFile(destination, `${sections.join('\n\n')}\n`);
  return destination;
}

/**
 * 判断 Bundle 模块图是否包含 Node 原生扩展。
 *
 * @param moduleId Rolldown 输出记录的 Module ID。
 * @returns 文件扩展名是 `.node` 时返回 true。
 */
function isNativeAddon(moduleId: string): boolean {
  /** 去掉查询参数后的真实模块路径。 */
  const normalized = moduleId.replace(/\?.*$/u, '');
  return path.extname(normalized) === '.node';
}

/**
 * 判断最终 Bundle 是否仍包含无法在构建期解析的动态 import 表达式。
 *
 * 字面量动态导入会被 Rolldown 内联，或作为允许的 `node:` external 保留；运行时表达式
 * 无法证明其代码和文件已经进入交付单元，因此必须拒绝。
 *
 * @param code Rolldown 生成的单 Chunk JavaScript。
 * @returns 存在非字符串字面量 ImportExpression 时返回 true。
 */
function hasUnresolvedDynamicImport(code: string): boolean {
  /** 使用宽只读对象遍历 ESTree，避免绑定解析器内部节点联合类型。 */
  const pending: unknown[] = [parseAst(code)];
  while (pending.length > 0) {
    /** 当前待检查的语法树节点或容器。 */
    const value = pending.pop();
    if (value === null || typeof value !== 'object')
      continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    /** 只读取 ESTree 公共 type/source/value 字段的节点视图。 */
    const node = value as Record<string, unknown>;
    if (node.type === 'ImportExpression') {
      /** 动态导入参数必须是构建器能够静态识别的字符串字面量。 */
      const source = node.source as Record<string, unknown> | undefined;
      if (source?.type !== 'Literal' || typeof source.value !== 'string')
        return true;
    }
    pending.push(...Object.values(node));
  }
  return false;
}

/**
 * 把 Rolldown 实际解析的 Server 模块图登记给 Core。
 *
 * @param context 当前 Extension build 上下文。
 * @param moduleIds 输出 Chunk 中的全部模块 ID。
 */
function registerBundleWatchFiles(context: ExtensionBuildContext, moduleIds: readonly string[]): void {
  for (const moduleId of moduleIds) {
    /** 查询参数不属于文件名，虚拟模块与相对 ID也不能交给文件监听器。 */
    const file = moduleId.replace(/\?.*$/u, '');
    if (path.isAbsolute(file))
      context.addWatchFile(file);
  }
}

/**
 * 判断 JSON-RPC 值是否是可安全读取字段的普通对象。
 *
 * @param value 从 Server stdout 解析出的未知 JSON 值。
 * @returns 非数组对象返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 使用最小无 Secret 环境真实执行 initialize、initialized 与 tools/list。
 *
 * Server stdout 只允许换行分隔的 JSON-RPC 消息。原始 stdout/stderr 永不进入错误、
 * Diagnostic 或 Artifact；超时和输出上限同时阻止构建被不可信实现无限占用。
 *
 * @param server 已生成的 Node 20 ESM Bundle。
 * @param definition 作者声明的 stdio 环境映射。
 * @returns 成功时返回 undefined，失败时返回固定类别。
 */
async function smokeTestServer(
  server: string,
  definition: Extract<DiscoveredMcpServer['definition'], { transport: 'stdio' }>,
): Promise<McpSmokeFailure | undefined> {
  /** 只有明确公开的 literal 值进入探测进程；env 引用对应的宿主 Secret 不会被读取。 */
  const environment = Object.fromEntries(Object.entries(definition.env ?? {})
    .filter((entry): entry is [string, { readonly value: string }] => 'value' in entry[1])
    .map(([name, source]) => [name, source.value]));

  return new Promise((resolve) => {
    /** 不经过 shell 的受限 Node 子进程。 */
    const child = spawn(process.execPath, [server], {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** 跨 stdout/stderr 共同计算、但永不持久化的输出字节数。 */
    let outputBytes = 0;
    /** stdout 分块之间尚未形成完整 JSON 行的尾部。 */
    let stdoutBuffer = '';
    /** initialize 成功后才允许接受 tools/list 响应。 */
    let initialized = false;
    /** tools/list 成功后等待子进程关闭再报告成功。 */
    let succeeded = false;
    /** 保证所有错误、close 与 timeout 竞争只结算一次。 */
    let settled = false;
    /** finish 请求后等待 close 时保存的稳定最终结果。 */
    let finalFailure: McpSmokeFailure | undefined;
    /** SIGTERM 后兜底使用 SIGKILL 的短定时器。 */
    let forceKill: NodeJS.Timeout | undefined;

    /**
     * 结束探测并确保子进程不会遗留活动句柄。
     *
     * @param failure 固定失败类别；省略表示协议已成功完成。
     */
    const finish = (failure?: McpSmokeFailure): void => {
      if (settled)
        return;
      settled = true;
      finalFailure = failure;
      clearTimeout(timeout);
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        forceKill = setTimeout(() => child.kill('SIGKILL'), 250);
        forceKill.unref();
      } else {
        resolve(finalFailure);
      }
    };

    /** 总时限覆盖启动、两个请求与进程通信。 */
    const timeout = setTimeout(() => finish('timeout'), MCP_SMOKE_TIMEOUT_MS);
    timeout.unref();

    /**
     * 处理单个完整 JSON-RPC stdout 行。
     *
     * @param line 不含行尾的协议消息。
     */
    const consumeLine = (line: string): void => {
      if (line.length === 0 || settled)
        return;
      /** 当前 stdout 行解析出的 JSON-RPC 候选。 */
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        finish('protocol');
        return;
      }
      if (!isRecord(message) || message.jsonrpc !== '2.0') {
        finish('protocol');
        return;
      }
      if (message.id === 1) {
        /** initialize 响应必须给出版本、能力和 Server 身份。 */
        const result = message.result;
        if (initialized || !isRecord(result) || typeof result.protocolVersion !== 'string'
          || !isRecord(result.capabilities) || !isRecord(result.serverInfo)
          || typeof result.serverInfo.name !== 'string' || typeof result.serverInfo.version !== 'string') {
          finish('protocol');
          return;
        }
        initialized = true;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
        return;
      }
      if (message.id === 2) {
        /** tools/list 必须发生在 initialize 之后并返回数组。 */
        if (!initialized || !isRecord(message.result) || !Array.isArray(message.result.tools)) {
          finish('protocol');
          return;
        }
        succeeded = true;
        finish();
      }
      // Server 主动发送的通知不影响两个必需响应，未知 response ID 也不会泄漏内容。
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MCP_SMOKE_OUTPUT_LIMIT) {
        finish('output-limit');
        return;
      }
      stdoutBuffer += chunk;
      /** 一次分块可能包含多个完整 JSON-RPC 行。 */
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines)
        consumeLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    });
    child.stderr.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MCP_SMOKE_OUTPUT_LIMIT)
        finish('output-limit');
    });
    child.once('error', () => finish('spawn'));
    child.once('close', () => {
      if (forceKill)
        clearTimeout(forceKill);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        finalFailure = succeeded ? undefined : 'process-exit';
      }
      resolve(finalFailure);
    });

    /** 第一条请求固定使用公开协议版本，不包含工程配置或环境值。 */
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'acplugin-build', version: '1.0.0' },
      },
    })}\n`);
  });
}

/**
 * 将完整本地 MCP 实现打包为单文件 Node 20 ESM，并收集第三方许可。
 *
 * @param entry 用户提供的本地 Server TypeScript 入口。
 * @param directory Extension 工作目录中的目标 Server 目录。
 * @returns 可由 Adapter 贡献的 Server 与可选许可文件。
 */
async function bundleServer(
  context: ExtensionBuildContext,
  entry: string,
  directory: string,
): Promise<BundledMcpServer> {
  /** 保留 Node 内置模块为 external 的内存构建结果。 */
  const output = await rolldownBuild({
    input: entry,
    platform: 'node',
    transform: { target: 'node20' },
    external: [/^node:/u],
    write: false,
    output: {
      format: 'esm',
      sourcemap: false,
      codeSplitting: false,
      comments: { legal: true },
    },
  });
  /** 构建产生的 JavaScript Chunk；协议要求严格只有一个。 */
  const chunks = output.output.filter((item): item is OutputChunk => item.type === 'chunk');
  if (chunks.length !== 1 || output.output.some(item => item.type === 'asset'))
    throw new Error('Local MCP Server must bundle to one JavaScript chunk and no assets.');
  /** 唯一输出 Chunk，用于原生依赖检查、写入和许可收集。 */
  const chunk = chunks[0]!;
  if (Object.keys(chunk.modules).some(isNativeAddon))
    throw new Error('Local MCP Server includes an unsupported native addon.');
  if (hasUnresolvedDynamicImport(chunk.code))
    throw new Error('Local MCP Server contains an unresolved dynamic import.');
  registerBundleWatchFiles(context, Object.keys(chunk.modules));
  await fs.mkdir(directory, { recursive: true });
  /** 最终贡献给交付单元的独立 ESM Server。 */
  const server = path.join(directory, 'server.mjs');
  await fs.writeFile(server, chunk.code);
  /** Bundle 包含第三方依赖时生成的许可汇总。 */
  const licenses = await writeThirdPartyLicenses(chunk, directory);
  return Object.freeze({ server, ...(licenses === undefined ? {} : { licenses }) });
}

/**
 * 为全部已验证 stdio Server 各生成一次平台中立 Bundle。
 *
 * @param context Core 提供的 Extension 隔离工作目录。
 * @param discovered 已通过 validate 阶段的 MCP 状态。
 * @returns 可由多个 Platform Adapter 复用的稳定 Built State。
 */
export async function buildMcpServers(
  context: ExtensionBuildContext,
  discovered: Readonly<DiscoveredMcpServers>,
): Promise<BuiltMcpServers> {
  /** 按发现顺序构建并保存定义的 Server 列表。 */
  const servers: BuiltMcpServer[] = [];
  for (const server of discovered.servers) {
    if (server.definition.transport === 'stdio') {
      /** validate 已确认留在 Server 目录内的本地入口。 */
      const entry = path.resolve(server.directory, server.definition.entry ?? './server.ts');
      /** 当前 Server 独占的 Bundle 工作目录。 */
      const directory = path.join(context.workDir, server.id);
      /** 当前 Server 生成且即将进行真实协议探测的 Bundle。 */
      const bundle = await bundleServer(context, entry, directory);
      /** 探测结果只保留固定分类，禁止把子进程输出带入报告。 */
      const smokeFailure = await smokeTestServer(bundle.server, server.definition);
      if (smokeFailure !== undefined) {
        context.reportDiagnostic({
          code: 'MCP_STDIO_SMOKE_FAILED',
          severity: 'error',
          message: `Local MCP Server "${server.id}" failed initialize/tools/list smoke (${smokeFailure}).`,
          location: {
            path: path.relative(context.project.root, server.descriptorPath).split(path.sep).join('/'),
          },
        });
      }
      servers.push(Object.freeze({
        id: server.id,
        definition: server.definition,
        bundle,
      }));
    } else {
      servers.push(Object.freeze({ id: server.id, definition: server.definition }));
    }
  }
  return Object.freeze({ servers: Object.freeze(servers) });
}
