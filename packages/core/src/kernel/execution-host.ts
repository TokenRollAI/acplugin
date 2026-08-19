import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import process from 'node:process';
import type { ExecutionResult, ExecutionService, GeneratedAssetRef } from '../kernel-types.js';
import { AssetRegistry } from './asset-registry.js';
import { WorkDirectoryRegistry } from './work-directories.js';

/** Execution Host 固定全局超时上限。 */
const MAX_TIMEOUT_MS = 60_000;

/** Execution Host 固定 stdout+stderr 单流字节上限。 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Execution Host stdin/args/env literal 单值上限。 */
const MAX_INPUT_BYTES = 1024 * 1024;

/** 调用方允许显式传入的普通环境变量名。 */
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** 永远拒绝通过 Execution API 注入的常见凭据变量名片段。 */
const SENSITIVE_ENVIRONMENT = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION|KEY)/u;

/** 会改变 Node/动态链接器执行边界的环境变量。 */
const RUNTIME_CONTROL_ENVIRONMENT = /^(?:(?:NODE|NPM|PNPM|YARN|LD|DYLD)_|PATH$|HOME$|USERPROFILE$|TMPDIR$|TEMP$|TMP$)/u;

/**
 * 校验调用方请求的正整数上限。
 *
 * @param value 请求值。
 * @param maximum Core 固定最大值。
 * @param label 稳定诊断字段。
 * @returns 可安全交给 timer/stream 的整数。
 */
function boundedInteger(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum)
    throw new Error(`${label} must be a positive integer no greater than ${maximum}.`);
  return value as number;
}

/**
 * 复制并验证一个 protocol-neutral literal 环境。
 *
 * @param input 调用方显式环境字段。
 * @returns 不继承 process.env 的最小环境。
 */
function executionEnvironment(input: unknown): NodeJS.ProcessEnv {
  if (input === undefined)
    return {};
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Execution environment must be a string map.');
  /** 只接受 data property，避免读取 getter。 */
  const descriptors = Object.getOwnPropertyDescriptors(input);
  /** 不继承宿主环境的全新最小环境。 */
  const environment: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(descriptors).sort()) {
    /** 当前环境变量的 data property descriptor。 */
    const descriptor = descriptors[name]!;
    if (!('value' in descriptor) || !ENVIRONMENT_NAME.test(name) || SENSITIVE_ENVIRONMENT.test(name)
      || RUNTIME_CONTROL_ENVIRONMENT.test(name)
      || typeof descriptor.value !== 'string' || Buffer.byteLength(descriptor.value) > 4096) {
      throw new Error('Execution environment contains an unsafe name or value.');
    }
    environment[name] = descriptor.value;
  }
  /** Windows Node 启动所需的系统根可以从宿主复制，但不会复制其他环境。 */
  if (process.platform === 'win32' && typeof process.env.SystemRoot === 'string')
    environment.SystemRoot = process.env.SystemRoot;
  return environment;
}

/** Execution Host 的 Session registries。 */
export interface ExecutionHostOptions {
  readonly assets: AssetRegistry;
  readonly workDirectories: WorkDirectoryRegistry;
}

/** Core 唯一 process execution boundary。 */
export class ExecutionHost {
  /** AssetRef runtime authorization 和 bytes snapshot。 */
  readonly #assets: AssetRegistry;
  /** owner-scoped 隔离 cwd 与 materialization root。 */
  readonly #workDirectories: WorkDirectoryRegistry;
  /** owner 内执行序号只用于 workDir 路径，不进入公开结果。 */
  readonly #sequences = new Map<string, number>();

  /**
   * 创建当前 BuildSession 的 Execution Host。
   *
   * @param options 当前 Session registries。
   */
  constructor(options: ExecutionHostOptions) {
    this.#assets = options.assets;
    this.#workDirectories = options.workDirectories;
  }

  /**
   * 为一个 owner 签发闭包绑定的 ExecutionService。
   *
   * @param owner 当前 Framework/Extension owner。
   * @returns 不接受调用方自报 owner 的执行能力。
   */
  service(owner: string): ExecutionService {
    if (typeof owner !== 'string' || owner.length === 0)
      throw new Error('Execution owner must be a non-empty string.');
    /** 显式类型注解保留 SDK request 的上下文类型。 */
    const service: ExecutionService = {
      /** portable entry 的授权和执行始终绑定当前 owner。 */
      runNode: request => this.#runNode(owner, request),
    };
    return Object.freeze(service);
  }

  /**
   * 物化并运行一个受权 portable-node entry。
   *
   * @param owner 当前 service owner。
   * @param request 执行入口和固定资源上限。
   * @returns 不携带 cwd/path/error stack 的稳定进程结果。
   */
  async #runNode(owner: string, request: {
    readonly entry: GeneratedAssetRef;
    readonly args?: readonly string[];
    readonly stdin?: Uint8Array | string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly environment?: Readonly<Record<string, string>>;
  }): Promise<ExecutionResult> {
    if (typeof request !== 'object' || request === null
      || Object.keys(request).some(field => !new Set(['entry', 'args', 'stdin', 'timeoutMs', 'maxOutputBytes', 'environment']).has(field))) {
      throw new Error('Execution request contains unknown fields.');
    }
    /** 当前请求经 Core 全局上限收窄后的超时。 */
    const timeoutMs = boundedInteger(request.timeoutMs, MAX_TIMEOUT_MS, 'Execution timeoutMs');
    /** 当前请求经 Core 全局上限收窄后的输出限制。 */
    const maxOutputBytes = boundedInteger(request.maxOutputBytes, MAX_OUTPUT_BYTES, 'Execution maxOutputBytes');
    /** entry 必须是当前 owner 可读且确实来自 portable main Chunk。 */
    const metadata = this.#assets.describe(owner, request.entry);
    if (metadata.kind !== 'generated-asset' || metadata.origin.type !== 'compile'
      || metadata.origin.profile !== 'portable-node' || metadata.origin.kind !== 'chunk') {
      throw new Error('Execution entry must be a portable-node generated chunk.');
    }
    /** 参数是不会经过 shell 的 literal string 数组。 */
    const args = request.args === undefined ? [] : [...request.args];
    if (args.some(value => typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 4096)
      || args.reduce((size, value) => size + Buffer.byteLength(value), 0) > MAX_INPUT_BYTES) {
      throw new Error('Execution args exceed the safe literal boundary.');
    }
    /** stdin 在 spawn 前复制，调用方后续 mutation 不影响执行。 */
    const stdin = request.stdin === undefined
      ? undefined
      : typeof request.stdin === 'string'
        ? Buffer.from(request.stdin)
        : Buffer.from(Uint8Array.from(request.stdin));
    if (stdin !== undefined && stdin.byteLength > MAX_INPUT_BYTES)
      throw new Error('Execution stdin exceeds the safe input boundary.');
    /** 不继承宿主变量的安全最小环境。 */
    const environment = executionEnvironment(request.environment);
    /** 每次执行使用 owner workDir 下新的隔离 cwd。 */
    const sequence = (this.#sequences.get(owner) ?? 0) + 1;
    this.#sequences.set(owner, sequence);
    /** 当前 owner 的唯一 workDir handle。 */
    const workDirectory = await this.#workDirectories.directory(owner);
    /** 本次执行独占的 workDir-relative 根。 */
    const relativeRoot = `execution/${sequence}`;
    /** 子进程隔离 cwd。 */
    const cwd = this.#workDirectories.resolve(owner, workDirectory, relativeRoot);
    /** portable main 的临时物化路径。 */
    const entry = this.#workDirectories.resolve(owner, workDirectory, `${relativeRoot}/main.mjs`);
    try {
      await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
      /** 读取同时复核生成文件 hash；临时物化保留受管 Asset mode。 */
      await fs.writeFile(entry, await this.#assets.read(owner, request.entry), { flag: 'wx', mode: metadata.mode });
      return await new Promise<ExecutionResult>((resolve, reject) => {
        /** 不经过 shell/PATH，只使用当前 Node executable。 */
        const child = spawn(process.execPath, [entry, ...args], {
          cwd,
          env: environment,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        /** 两个输出流分别在同一 Core 上限内收集。 */
        const stdout: Buffer[] = [];
        /** stderr 的稳定 chunk snapshots。 */
        const stderr: Buffer[] = [];
        /** stdout 与 stderr 共享同一个请求输出预算。 */
        let outputSize = 0;
        /** timeout/output-limit 提前决定的稳定状态。 */
        let terminalStatus: ExecutionResult['status'] | undefined;
        /** error/close 只能完成 Promise 一次。 */
        let settled = false;
        /** 超时触发后强制终止，不返回原始错误。 */
        const terminate = (status: 'timed-out' | 'output-limit'): void => {
          if (terminalStatus !== undefined)
            return;
          terminalStatus = status;
          child.kill('SIGKILL');
        };
        /** 当前请求固定超时计时器。 */
        const timeout = setTimeout(() => terminate('timed-out'), timeoutMs);
        /** 输出超限时不保存越界 chunk 并终止。 */
        const collect = (target: Buffer[], chunk: Buffer): void => {
          /** 两个输出流加入当前 chunk 后的候选总大小。 */
          const next = outputSize + chunk.byteLength;
          if (next > maxOutputBytes) {
            terminate('output-limit');
            return;
          }
          target.push(Buffer.from(chunk));
          outputSize = next;
        };
        child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
        child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
        /** 子进程提前退出造成的 EPIPE 不得成为未处理的宿主异常。 */
        child.stdin.on('error', () => undefined);
        child.once('error', () => {
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            reject(new Error('Node execution could not start.'));
          }
        });
        child.once('close', (exitCode, signal) => {
          clearTimeout(timeout);
          if (settled)
            return;
          settled = true;
          resolve(Object.freeze({
            status: terminalStatus ?? (signal === null ? 'exited' : 'signaled'),
            exitCode,
            signal,
            stdout: Uint8Array.from(Buffer.concat(stdout)),
            stderr: Uint8Array.from(Buffer.concat(stderr)),
          }));
        });
        if (stdin === undefined)
          child.stdin.end();
        else
          child.stdin.end(stdin);
      });
    } finally {
      /** execution work materialization 在所有成功/失败路径清理。 */
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
}
