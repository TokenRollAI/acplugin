import path from 'node:path';
import { MAX_HOOK_IO_BYTES } from './constants.js';
import type { DiscoveredHook } from './discovery.js';

/**
 * 生成单个 Hook 的平台中立隔离运行器源码。
 *
 * Handler 只拥有有限 I/O、规范结果校验和用户实现调用；相邻 `wire.mjs`
 * 由当前 Platform Adapter 贡献，负责平台原生输入与输出协议。生成字符串属于
 * 最终 Plugin 运行时代码，不机械注入开发期中文注释。
 *
 * @param hook 当前 Hook 定义及其源码路径。
 * @param runnerDirectory 临时运行器目录，用于计算可打包的相对导入路径。
 * @returns 可交给 Rolldown 的 Node 20 ESM 入口源码。
 */
export function createRunnerSource(hook: DiscoveredHook, runnerDirectory: string): string {
  /** 从生成运行器到用户 hook.ts 的 ESM 相对导入路径。 */
  let importPath = path.relative(runnerDirectory, hook.sourcePath).split(path.sep).join('/');
  if (!importPath.startsWith('.'))
    importPath = `./${importPath}`;
  return `
const MAX_BYTES = ${MAX_HOOK_IO_BYTES};
const MAX_JSON_DEPTH = 128;
const PLATFORM_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVENT_RESULTS = {
  SessionStart: { decisions: ['continue', 'stop'], fields: ['reason', 'additionalContext'] },
  SessionEnd: { decisions: [], fields: [] },
  UserPromptSubmit: { decisions: ['allow', 'deny'], fields: ['reason', 'additionalContext'] },
  PreToolUse: { decisions: ['allow', 'deny'], fields: ['reason', 'updatedInput', 'additionalContext'] },
  PermissionRequest: { decisions: ['allow', 'deny', 'defer'], fields: ['reason'] },
  PostToolUse: { decisions: ['pass', 'block'], fields: ['reason', 'additionalContext'] },
  PreCompact: { decisions: ['continue', 'stop'], fields: ['reason'] },
  PostCompact: { decisions: ['continue', 'stop'], fields: ['reason'] },
  SubagentStart: { decisions: [], fields: ['additionalContext'] },
  SubagentStop: { decisions: ['finish', 'continue'], fields: ['reason'] },
  Stop: { decisions: ['finish', 'continue'], fields: ['reason'] },
};
const ERROR_CODES = new Set([
  'HANDLER_ASYNC_FAILED', 'HANDLER_EXIT_FORBIDDEN', 'HANDLER_FAILED', 'HANDLER_IMPORT_FAILED',
  'HANDLER_INCOMPLETE', 'HANDLER_OUTPUT_FORBIDDEN', 'HANDLER_OUTPUT_TOO_LARGE',
  'INPUT_COMMON_INVALID', 'INPUT_EVENT_INVALID', 'INPUT_EVENT_MISMATCH', 'INPUT_JSON_INVALID',
  'INPUT_KEY_COLLISION', 'INPUT_OBJECT_REQUIRED', 'INPUT_TOO_DEEP', 'INPUT_TOO_LARGE',
  'OUTPUT_TOO_LARGE', 'PLATFORM_EVENT_MISMATCH', 'PLATFORM_INVALID', 'RESULT_DECISION_INVALID',
  'RESULT_EVENT_INVALID', 'RESULT_FIELD_INVALID', 'RESULT_INVALID', 'RESULT_SERIALIZATION_FAILED',
  'RESULT_UPDATED_INPUT_INVALID', 'WIRE_CONTEXT_INVALID', 'WIRE_IMPORT_FAILED', 'WIRE_PLATFORM_MISMATCH',
]);

function isJsonValue(value, depth = 0, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > MAX_JSON_DEPTH || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isJsonValue(value[index], depth + 1, ancestors)) return false;
      }
      return true;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !isJsonValue(value[key], depth + 1, ancestors)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function validateResult(event, result, isPlatformEvent) {
  if (result === undefined) return;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('RESULT_INVALID');
  const contract = isPlatformEvent ? { decisions: [], fields: [] } : EVENT_RESULTS[event];
  if (!contract) throw new Error('RESULT_EVENT_INVALID');
  const allowedFields = new Set(['decision', 'systemMessage', ...contract.fields]);
  if (Object.keys(result).some(field => !allowedFields.has(field))) throw new Error('RESULT_FIELD_INVALID');
  for (const field of ['reason', 'additionalContext', 'systemMessage']) {
    if (result[field] !== undefined && typeof result[field] !== 'string') throw new Error('RESULT_INVALID');
  }
  if (result.decision !== undefined && !contract.decisions.includes(result.decision))
    throw new Error('RESULT_DECISION_INVALID');
  if (result.updatedInput !== undefined) {
    if (event !== 'PreToolUse' || result.decision !== 'allow' || !isJsonValue(result.updatedInput))
      throw new Error('RESULT_UPDATED_INPUT_INVALID');
  }
}

async function readInput() {
  const chunks = [];
  let byteLength = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    byteLength += chunk.byteLength;
    if (byteLength > MAX_BYTES) throw new Error('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, byteLength).toString('utf8'));
  } catch {
    throw new Error('INPUT_JSON_INVALID');
  }
}

async function loadDefinition() {
  try {
    const namespace = await import(${JSON.stringify(importPath)});
    return namespace.default;
  } catch {
    throw new Error('HANDLER_IMPORT_FAILED');
  }
}

async function loadWire() {
  try {
    const wireUrl = new URL('./wire.mjs', import.meta.url);
    return await import(wireUrl.href);
  } catch {
    throw new Error('WIRE_IMPORT_FAILED');
  }
}

const safeStdout = process.stdout.write.bind(process.stdout);
const safeStderr = process.stderr.write.bind(process.stderr);
let interceptedBytes = 0;
let interceptedFailure;
let serializedOutput;
let failureCode;
let mainCompleted = false;
let finalized = false;
let finalizationArmed = false;

function stableErrorCode(error, fallback) {
  return error instanceof Error && ERROR_CODES.has(error.message) ? error.message : fallback;
}

function intercept(chunk, encoding, callback) {
  interceptedBytes += Buffer.byteLength(typeof chunk === 'string' ? chunk : chunk);
  if (interceptedBytes > MAX_BYTES) {
    interceptedFailure = 'HANDLER_OUTPUT_TOO_LARGE';
    throw new Error(interceptedFailure);
  }
  const completed = typeof encoding === 'function' ? encoding : callback;
  if (typeof completed === 'function') queueMicrotask(completed);
  return true;
}

process.stdout.write = intercept;
process.stderr.write = intercept;
process.exit = () => {
  throw new Error('HANDLER_EXIT_FORBIDDEN');
};

process.on('uncaughtException', (error) => {
  failureCode = stableErrorCode(error, 'HANDLER_ASYNC_FAILED');
  process.exitCode = 1;
});

process.on('unhandledRejection', (error) => {
  failureCode = stableErrorCode(error, 'HANDLER_ASYNC_FAILED');
  process.exitCode = 1;
});

function finalize() {
  if (finalized) return;
  finalized = true;
  if (!mainCompleted && failureCode === undefined) failureCode = 'HANDLER_INCOMPLETE';
  if (interceptedFailure !== undefined) failureCode = interceptedFailure;
  else if (interceptedBytes > 0 && failureCode === undefined) failureCode = 'HANDLER_OUTPUT_FORBIDDEN';
  if (failureCode !== undefined) {
    safeStderr('acplugin hook error: ' + failureCode + '\\n');
    process.exitCode = 1;
  } else if (serializedOutput !== undefined) {
    safeStdout(serializedOutput + '\\n');
  }
}

process.on('beforeExit', () => {
  if (finalized) return;
  if (finalizationArmed) {
    finalize();
    return;
  }
  finalizationArmed = true;
  setImmediate(() => {});
});

async function main() {
  const platform = process.argv[2];
  if (typeof platform !== 'string' || !PLATFORM_PATTERN.test(platform)) throw new Error('PLATFORM_INVALID');
  const [definition, wire] = await Promise.all([loadDefinition(), loadWire()]);
  if (!wire
    || wire.platform !== platform
    || typeof wire.contextFor !== 'function'
    || typeof wire.inputFor !== 'function'
    || typeof wire.outputFor !== 'function')
    throw new Error('WIRE_PLATFORM_MISMATCH');
  const declaredEvent = definition && definition.event;
  const expectedEvent = typeof declaredEvent === 'string' ? declaredEvent : declaredEvent && declaredEvent.name;
  const platformEvent = typeof declaredEvent === 'object' && declaredEvent !== null;
  if (platformEvent && declaredEvent.platform !== platform) throw new Error('PLATFORM_EVENT_MISMATCH');
  const raw = await readInput();
  const input = wire.inputFor(raw, expectedEvent, declaredEvent);
  const runtimeContext = wire.contextFor(process.env);
  if (!runtimeContext
    || typeof runtimeContext !== 'object'
    || typeof runtimeContext.pluginRoot !== 'string'
    || typeof runtimeContext.pluginData !== 'string')
    throw new Error('WIRE_CONTEXT_INVALID');
  let result;
  try {
    result = await definition.run(input, Object.freeze({
      platform,
      pluginRoot: runtimeContext.pluginRoot,
      pluginData: runtimeContext.pluginData,
    }));
  } catch {
    throw new Error('HANDLER_FAILED');
  }
  validateResult(expectedEvent, result, platformEvent);
  const output = wire.outputFor(expectedEvent, result);
  if (output) {
    try {
      serializedOutput = JSON.stringify(output);
    } catch {
      throw new Error('RESULT_SERIALIZATION_FAILED');
    }
    if (Buffer.byteLength(serializedOutput) > MAX_BYTES) throw new Error('OUTPUT_TOO_LARGE');
  }
}

main().then(() => {
  mainCompleted = true;
}).catch((error) => {
  mainCompleted = true;
  failureCode = stableErrorCode(error, 'HOOK_FAILED');
  process.exitCode = 1;
});
`;
}
