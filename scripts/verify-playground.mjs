import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/** Promise 化的子进程执行器，用于消费真实 CLI JSON。 */
const execute = promisify(execFile);
/** 当前仓库根目录。 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Playground 工程根目录。 */
const playground = path.join(root, 'packages/playground');
/** Playground 的完整托管输出目录。 */
const outputRoot = path.join(playground, 'dist');
/** 已构建的真实 ACPlugin CLI 入口。 */
const cli = path.join(root, 'packages/acplugin/dist/cli.mjs');
/** 构建时注入、但绝不能进入报告或产物的 Secret 标记。 */
const secretMarker = 'PLAYGROUND_SECRET_MUST_NOT_LEAK_7c2e9a';
/** 六个官方 Platform 的固定顺序。 */
const platforms = ['antigravity', 'claude-code', 'codex', 'cursor', 'opencode', 'pi'];
/** 四个规范 Command ID。 */
const commands = ['init', 'prune', 'update', 'upgrade'];
/** 三个规范 Agent ID。 */
const agents = ['investigator', 'recorder', 'reflector'];
/** Skill 中必须按原始字节复制的辅助文件。 */
const skillAuxiliary = [
  'assets/icon-large.svg',
  'assets/icon-small.svg',
  'references/context-continuation.md',
  'references/planning.md',
  'references/review.md',
  'references/verification.md',
];
/** 11 个 portable Hook 的 ID 与规范事件名。 */
const hookEvents = Object.freeze({
  'permission-request': 'PermissionRequest',
  'post-compact': 'PostCompact',
  'post-tool-use': 'PostToolUse',
  'pre-compact': 'PreCompact',
  'pre-tool-use': 'PreToolUse',
  'session-end': 'SessionEnd',
  'session-start': 'SessionStart',
  'stop': 'Stop',
  'subagent-start': 'SubagentStart',
  'subagent-stop': 'SubagentStop',
  'user-prompt-submit': 'UserPromptSubmit',
});
/** 每个平台对每个 portable Hook 事件的精确兼容性结论。 */
const hookEventLevels = Object.freeze({
  'antigravity': {
    'permission-request': 'unsupported',
    'post-compact': 'unsupported',
    'post-tool-use': 'native',
    'pre-compact': 'native',
    'pre-tool-use': 'native',
    'session-end': 'native',
    'session-start': 'native',
    'stop': 'unsupported',
    'subagent-start': 'unsupported',
    'subagent-stop': 'unsupported',
    'user-prompt-submit': 'unsupported',
  },
  'claude-code': Object.fromEntries(Object.keys(hookEvents).map(id => [id, 'native'])),
  'codex': Object.fromEntries(Object.keys(hookEvents).map(id => [id, 'native'])),
  'cursor': {
    'permission-request': 'unsupported',
    'post-compact': 'unsupported',
    'post-tool-use': 'transform',
    'pre-compact': 'transform',
    'pre-tool-use': 'transform',
    'session-end': 'transform',
    'session-start': 'transform',
    'stop': 'transform',
    'subagent-start': 'transform',
    'subagent-stop': 'transform',
    'user-prompt-submit': 'transform',
  },
  'opencode': {
    'permission-request': 'unsupported',
    'post-compact': 'native',
    'post-tool-use': 'native',
    'pre-compact': 'unsupported',
    'pre-tool-use': 'native',
    'session-end': 'degraded',
    'session-start': 'native',
    'stop': 'degraded',
    'subagent-start': 'unsupported',
    'subagent-stop': 'unsupported',
    'user-prompt-submit': 'native',
  },
  'pi': {
    'permission-request': 'unsupported',
    'post-compact': 'native',
    'post-tool-use': 'native',
    'pre-compact': 'native',
    'pre-tool-use': 'native',
    'session-end': 'native',
    'session-start': 'native',
    'stop': 'degraded',
    'subagent-start': 'unsupported',
    'subagent-stop': 'unsupported',
    'user-prompt-submit': 'native',
  },
});

/** 在 Playground 报告或产物不满足预期时使用稳定消息失败。 */
function assert(condition, message) {
  if (!condition)
    throw new Error(message);
}

/** 按 UTF-16 code unit 稳定排序路径和兼容性键。 */
function compareCodeUnits(left, right) {
  if (left === right)
    return 0;
  return left < right ? -1 : 1;
}

/** 创建兼容性记录的唯一结构化键。 */
function compatibilityKey(entry) {
  return `${entry.platform}\0${entry.level}\0${entry.subject}\0${entry.capability}`;
}

/** 创建不包含 level 的兼容性查询键。 */
function compatibilityLookupKey(platform, subject, capability) {
  return `${platform}\0${subject}\0${capability}`;
}

/** 读取 UTF-8 文件。 */
async function readText(file) {
  return fs.readFile(file, 'utf8');
}

/** 读取并解析 JSON 文件。 */
async function readJson(file) {
  return JSON.parse(await readText(file));
}

/** 判断路径是否存在，不把其他文件系统错误吞成 missing。 */
async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT')
      return false;
    throw error;
  }
}

/** 递归列出目录中的普通文件，并拒绝意外符号链接。 */
async function listFiles(directory, prefix = '') {
  /** 当前目录按名称稳定排序后的条目。 */
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  /** 当前子树累计的 POSIX 相对文件路径。 */
  const files = [];
  for (const entry of entries) {
    /** 当前条目的绝对路径。 */
    const absolute = path.join(directory, entry.name);
    /** Artifact Registry 使用的 POSIX 相对路径。 */
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    assert(!entry.isSymbolicLink(), `Playground output contains unexpected symlink ${relative}.`);
    if (entry.isDirectory())
      files.push(...await listFiles(absolute, relative));
    else {
      assert(entry.isFile(), `Playground output contains non-file entry ${relative}.`);
      files.push(relative);
    }
  }
  return files;
}

/** 对完整 dist 树建立包含路径、mode 和字节 hash 的稳定快照。 */
async function snapshotOutput() {
  /** 当前输出中所有普通文件的稳定路径。 */
  const files = await listFiles(outputRoot);
  /** 每个文件的权限与字节摘要。 */
  const snapshot = [];
  for (const file of files) {
    /** 当前产物的绝对路径。 */
    const absolute = path.join(outputRoot, file);
    /** 当前产物的权限信息。 */
    const stat = await fs.stat(absolute);
    /** 当前产物的原始字节。 */
    const bytes = await fs.readFile(absolute);
    snapshot.push(`${file}\0${stat.mode & 0o777}\0${createHash('sha256').update(bytes).digest('hex')}`);
  }
  return snapshot;
}

/** 运行真实 CLI command，并传入构建期 Secret 泄漏探针。 */
async function runCli(command) {
  /** CLI 稳定 JSON 模式产生的标准输出。 */
  const { stdout } = await execute(process.execPath, [cli, command, '--json'], {
    cwd: playground,
    env: {
      ...process.env,
      PLAYGROUND_LOCAL_TOKEN: secretMarker,
      PLAYGROUND_MCP_TENANT: secretMarker,
      PLAYGROUND_MCP_TOKEN: secretMarker,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/** 在不经过 shell 的子进程中运行 Hook 或 MCP 协议输入。 */
async function runProtocol(file, arguments_, input, environment = {}) {
  return new Promise((resolve, reject) => {
    /** 被验证的真实生成程序。 */
    const child = spawn(process.execPath, [file, ...arguments_], {
      cwd: path.dirname(file),
      env: { ...process.env, ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** 当前协议运行的完整标准输出。 */
    let stdout = '';
    /** 当前协议运行的完整标准错误。 */
    let stderr = '';
    /** 防止损坏模板令验证器无限等待的超时。 */
    const timer = setTimeout(() => child.kill('SIGTERM'), 5_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/** 向 expected non-native 集合增加一条精确结论。 */
function addExpected(target, platform, level, subject, capability) {
  target.add(`${platform}\0${level}\0${subject}\0${capability}`);
}

/** 从模板能力矩阵生成全部允许的 degraded/unsupported 白名单。 */
function expectedNonNativeEntries() {
  /** 只允许显式登记的非无损兼容性记录。 */
  const expected = new Set();
  for (const platform of ['antigravity', 'codex', 'pi']) {
    for (const agent of agents) {
      for (const capability of ['agent.capabilities', 'agent.model', 'component'])
        addExpected(expected, platform, 'degraded', `agent:${agent}`, capability);
    }
  }
  addExpected(expected, 'cursor', 'degraded', 'agent:investigator', 'agent.model');
  addExpected(expected, 'cursor', 'degraded', 'agent:recorder', 'agent.capabilities');
  addExpected(expected, 'cursor', 'degraded', 'agent:reflector', 'agent.model');
  addExpected(expected, 'opencode', 'degraded', 'agent:investigator', 'agent.model');
  addExpected(expected, 'opencode', 'degraded', 'agent:reflector', 'agent.model');

  for (const platform of ['antigravity', 'codex', 'cursor', 'opencode'])
    addExpected(expected, platform, 'degraded', 'command:init', 'argumentHint');
  /** 依赖 Agent 降级后必须传播到对应 Command 的稳定映射。 */
  const dependencyCommands = {
    prune: 'reflector',
    update: 'investigator',
    upgrade: 'recorder',
  };
  for (const platform of ['antigravity', 'codex', 'cursor', 'pi']) {
    for (const [command, agent] of Object.entries(dependencyCommands))
      addExpected(expected, platform, 'degraded', `command:${command}`, `dependency:agent:${agent}`);
  }
  for (const [command, agent] of Object.entries(dependencyCommands).filter(([id]) => id !== 'upgrade'))
    addExpected(expected, 'opencode', 'degraded', `command:${command}`, `dependency:agent:${agent}`);

  for (const platform of platforms) {
    for (const [id, event] of Object.entries(hookEvents)) {
      /** 当前事件在目标 Platform 的精确支持等级。 */
      const level = hookEventLevels[platform][id];
      if (level === 'degraded' || level === 'unsupported')
        addExpected(expected, platform, level, `hook:${id}`, `event.${event}`);
    }
  }
  for (const platform of ['antigravity', 'cursor', 'opencode', 'pi']) {
    for (const hook of ['pre-tool-use', 'session-start'])
      addExpected(expected, platform, 'degraded', `hook:${hook}`, 'statusMessage');
  }

  for (const platform of ['antigravity', 'cursor']) {
    addExpected(expected, platform, 'unsupported', 'mcp:local-tools', 'transport.stdio');
    addExpected(expected, platform, 'degraded', 'mcp:oauth-docs', 'auth.oauth.scopes');
  }
  addExpected(expected, 'pi', 'unsupported', 'mcp:local-tools', 'transport.stdio');
  for (const id of ['oauth-docs', 'protected-docs', 'public-docs'])
    addExpected(expected, 'pi', 'unsupported', `mcp:${id}`, 'transport.http');
  assert(expected.size === 84, 'Playground verifier has an inconsistent non-native policy table.');
  return expected;
}

/** 校验报告结构、兼容性矩阵、诊断和 DeliveryUnit 覆盖。 */
function verifyReport(report, command) {
  assert(report.success === true, `Playground ${command} did not succeed.`);
  assert(report.command === command, `Playground ${command} report has the wrong command.`);
  assert(report.committed === (command === 'build'), `Playground ${command} has the wrong committed state.`);
  assert(JSON.stringify(report.platforms) === JSON.stringify(platforms), 'Playground report has the wrong Platform set.');
  assert(report.compatibility.length === 211, 'Playground compatibility coverage changed unexpectedly.');

  /** 所有 compatibility 条目的唯一查询索引。 */
  const compatibility = new Map();
  for (const entry of report.compatibility) {
    /** 忽略 level 后仍应唯一的精确兼容性身份。 */
    const key = compatibilityLookupKey(entry.platform, entry.subject, entry.capability);
    assert(!compatibility.has(key), `Playground report duplicates compatibility ${key.replaceAll('\0', ' / ')}.`);
    compatibility.set(key, entry);
  }
  /** 查询并校验一条必须存在的结构化兼容性记录。 */
  const expectLevel = (platform, subject, capability, level) => {
    /** 当前期望记录对应的唯一查询键。 */
    const key = compatibilityLookupKey(platform, subject, capability);
    /** 按查询键取得的实际兼容性记录。 */
    const entry = compatibility.get(key);
    assert(entry !== undefined, `Playground report is missing ${key.replaceAll('\0', ' / ')}.`);
    assert(entry.level === level, `Playground report has wrong level for ${key.replaceAll('\0', ' / ')}.`);
  };

  /** 三类 Component 在各 Platform 的主资源等级。 */
  const componentLevels = {
    'antigravity': { command: 'transform', skill: 'native', agent: 'degraded' },
    'claude-code': { command: 'native', skill: 'native', agent: 'native' },
    'codex': { command: 'transform', skill: 'native', agent: 'degraded' },
    'cursor': { command: 'native', skill: 'native', agent: 'native' },
    'opencode': { command: 'native', skill: 'native', agent: 'native' },
    'pi': { command: 'transform', skill: 'native', agent: 'degraded' },
  };
  for (const platform of platforms) {
    for (const command of commands)
      expectLevel(platform, `command:${command}`, 'component', componentLevels[platform].command);
    expectLevel(platform, 'skill:project-workflow', 'component', componentLevels[platform].skill);
    for (const agent of agents)
      expectLevel(platform, `agent:${agent}`, 'component', componentLevels[platform].agent);
    for (const [id, event] of Object.entries(hookEvents))
      expectLevel(platform, `hook:${id}`, `event.${event}`, hookEventLevels[platform][id]);
  }

  /** 每个平台必须精确报告的 MCP 能力键与等级。 */
  const mcpLevels = {
    'antigravity': [
      ['local-tools', 'transport.stdio', 'unsupported'], ['oauth-docs', 'auth.oauth.scopes', 'degraded'],
      ['oauth-docs', 'transport.http', 'native'], ['protected-docs', 'auth.bearer', 'native'],
      ['protected-docs', 'transport.http', 'native'], ['public-docs', 'auth.none', 'native'],
      ['public-docs', 'transport.http', 'native'],
    ],
    'claude-code': [
      ['local-tools', 'transport.stdio', 'native'], ['oauth-docs', 'auth.oauth', 'native'],
      ['oauth-docs', 'transport.http', 'native'], ['protected-docs', 'auth.bearer', 'native'],
      ['protected-docs', 'transport.http', 'native'], ['public-docs', 'auth.none', 'native'],
      ['public-docs', 'transport.http', 'native'],
    ],
    'codex': [
      ['local-tools', 'transport.stdio', 'native'], ['oauth-docs', 'auth.oauth', 'native'],
      ['oauth-docs', 'transport.http', 'native'], ['protected-docs', 'auth.bearer', 'native'],
      ['protected-docs', 'transport.http', 'native'], ['public-docs', 'auth.none', 'native'],
      ['public-docs', 'transport.http', 'native'],
    ],
    'cursor': [
      ['local-tools', 'transport.stdio', 'unsupported'], ['oauth-docs', 'auth.oauth.scopes', 'degraded'],
      ['oauth-docs', 'transport.http', 'native'], ['protected-docs', 'auth.bearer', 'native'],
      ['protected-docs', 'transport.http', 'native'], ['public-docs', 'auth.none', 'native'],
      ['public-docs', 'transport.http', 'native'],
    ],
    'opencode': [
      ['local-tools', 'transport.stdio', 'native'], ['oauth-docs', 'auth.oauth', 'native'],
      ['oauth-docs', 'transport.http', 'native'], ['protected-docs', 'auth.bearer', 'native'],
      ['protected-docs', 'transport.http', 'native'], ['public-docs', 'auth.none', 'native'],
      ['public-docs', 'transport.http', 'native'],
    ],
    'pi': [
      ['local-tools', 'transport.stdio', 'unsupported'], ['oauth-docs', 'transport.http', 'unsupported'],
      ['protected-docs', 'transport.http', 'unsupported'], ['public-docs', 'transport.http', 'unsupported'],
    ],
  };
  for (const platform of platforms) {
    /** 当前 Platform 实际出现的 MCP 兼容性条目。 */
    const actual = report.compatibility.filter(entry => entry.platform === platform && entry.subject.startsWith('mcp:'));
    assert(actual.length === mcpLevels[platform].length, `${platform} has unexpected MCP compatibility coverage.`);
    for (const [id, capability, level] of mcpLevels[platform])
      expectLevel(platform, `mcp:${id}`, capability, level);
  }

  /** 报告中实际出现的全部 degraded/unsupported 结构化键。 */
  const actualNonNative = new Set(report.compatibility
    .filter(entry => entry.level === 'degraded' || entry.level === 'unsupported')
    .map(compatibilityKey));
  /** 模板显式接受的完整非无损能力集合。 */
  const expectedNonNative = expectedNonNativeEntries();
  assert(actualNonNative.size === expectedNonNative.size, 'Playground report has an unexpected number of non-native entries.');
  for (const key of expectedNonNative)
    assert(actualNonNative.has(key), `Playground report is missing accepted non-native entry ${key.replaceAll('\0', ' / ')}.`);
  for (const key of actualNonNative)
    assert(expectedNonNative.has(key), `Playground report contains unexpected non-native entry ${key.replaceAll('\0', ' / ')}.`);

  /** 允许的非兼容性诊断及其精确数量。 */
  const diagnosticCounts = {
    ANTIGRAVITY_METADATA_OMITTED: 8,
    COMPATIBILITY_RELAXED: 84,
    CURSOR_METADATA_AUTHOR_URL_OMITTED: 1,
    METADATA_OMITTED: 18,
    PI_METADATA_DISPLAY_NAME_OMITTED: 1,
  };
  /** 按稳定 code 汇总报告诊断。 */
  const actualDiagnosticCounts = Object.fromEntries(Object.entries(Object.groupBy(report.diagnostics, item => item.code))
    .map(([code, items]) => [code, items.length]));
  assert(Object.keys(actualDiagnosticCounts).length === Object.keys(diagnosticCounts).length, 'Playground diagnostics contain an unexpected code.');
  for (const [code, count] of Object.entries(diagnosticCounts))
    assert(actualDiagnosticCounts[code] === count, `Playground diagnostic ${code} has an unexpected count.`);
  assert(report.diagnostics.every(item => item.severity === 'warning'), 'Playground report contains a non-warning diagnostic.');

  /** 预期的主交付与可选 Marketplace 交付身份。 */
  const expectedUnits = [
    'antigravity\0plugin\0primary\0plugin',
    'claude-code\0marketplace\0distribution\0marketplace',
    'claude-code\0plugin\0primary\0plugin',
    'codex\0marketplace\0distribution\0marketplace',
    'codex\0plugin\0primary\0plugin',
    'cursor\0plugin\0primary\0plugin',
    'opencode\0workspace\0primary\0workspace',
    'pi\0package\0primary\0package',
  ];
  /** 实际 DeliveryUnit 的结构化身份。 */
  const actualUnits = report.deliveryUnits.map(unit => `${unit.platform}\0${unit.id}\0${unit.role}\0${unit.type}`);
  assert(JSON.stringify(actualUnits) === JSON.stringify(expectedUnits), 'Playground DeliveryUnit topology changed unexpectedly.');
}

/** 校验报告 Artifact 清单与 dist 中实际文件精确一致。 */
async function verifyArtifactClosure(report) {
  /** dist 只能包含本次选择的六个平台目录。 */
  const platformDirectories = (await fs.readdir(outputRoot)).sort(compareCodeUnits);
  assert(JSON.stringify(platformDirectories) === JSON.stringify(platforms), 'Managed dist contains a stale or missing Platform directory.');
  for (const unit of report.deliveryUnits) {
    /** 当前交付单元的真实安装根。 */
    const directory = path.join(outputRoot, unit.platform, unit.id);
    /** 文件系统实际 materialize 的 Artifact 路径。 */
    const actual = (await listFiles(directory)).sort(compareCodeUnits);
    /** 报告中经过 owner/hash 校验的 Artifact 路径。 */
    const reported = unit.artifacts.map(artifact => artifact.path).sort(compareCodeUnits);
    assert(JSON.stringify(actual) === JSON.stringify(reported), `${unit.platform}/${unit.id} files do not match the BuildResult Artifact registry.`);
  }
}

/** 校验 Canonical Component、Skill auxiliary 和 Public 复制内容。 */
async function verifyCanonicalOutputs() {
  /** 六个平台各自的主交付安装根。 */
  const roots = {
    'antigravity': path.join(outputRoot, 'antigravity/plugin'),
    'claude-code': path.join(outputRoot, 'claude-code/plugin'),
    'codex': path.join(outputRoot, 'codex/plugin'),
    'cursor': path.join(outputRoot, 'cursor/plugin'),
    'opencode': path.join(outputRoot, 'opencode/workspace'),
    'pi': path.join(outputRoot, 'pi/package'),
  };
  /** 每个平台中 Command 的最终路径函数。 */
  const commandPath = {
    /** Antigravity 把 Command 转换为 Skill。 */
    'antigravity': id => `skills/command-${id}/SKILL.md`,
    /** Claude Code 保留原生 Command。 */
    'claude-code': id => `commands/${id}.md`,
    /** Codex 把 Command 转换为 Skill。 */
    'codex': id => `skills/command-${id}/SKILL.md`,
    /** Cursor 保留原生 Command。 */
    'cursor': id => `commands/${id}.md`,
    /** OpenCode 把 Command 写入工作区目录。 */
    'opencode': id => `.opencode/commands/${id}.md`,
    /** Pi 把 Command 转换为 Prompt。 */
    'pi': id => `prompts/${id}.md`,
  };
  /** 每个平台中原生或 fallback Agent 的最终路径函数。 */
  const agentPath = {
    /** Antigravity 把 Agent 降级为 Skill。 */
    'antigravity': id => `skills/agent-${id}/SKILL.md`,
    /** Claude Code 保留原生 Agent。 */
    'claude-code': id => `agents/${id}.md`,
    /** Codex 把 Agent 降级为 Skill。 */
    'codex': id => `skills/agent-${id}/SKILL.md`,
    /** Cursor 保留原生 Agent。 */
    'cursor': id => `agents/${id}.md`,
    /** OpenCode 把 Agent 写入工作区目录。 */
    'opencode': id => `.opencode/agents/${id}.md`,
    /** Pi 把 Agent 降级为 Skill。 */
    'pi': id => `skills/agent-${id}/SKILL.md`,
  };
  /** 每个平台中 project-workflow Skill 的最终根。 */
  const skillRoot = {
    'antigravity': 'skills/project-workflow',
    'claude-code': 'skills/project-workflow',
    'codex': 'skills/project-workflow',
    'cursor': 'skills/project-workflow',
    'opencode': '.opencode/skills/project-workflow',
    'pi': 'skills/project-workflow',
  };

  for (const platform of platforms) {
    for (const command of commands) {
      /** 当前 Platform 的 Command 或转换后 Skill/Prompt 内容。 */
      const content = await readText(path.join(roots[platform], commandPath[platform](command)));
      assert(content.includes('description:'), `${platform} ${command} output is missing frontmatter.`);
      assert(content.includes('ACPlugin capability template'), `${platform} ${command} output lost its canonical body.`);
    }
    /** init 是唯一带 argumentHint 和参数占位符的覆盖用例。 */
    const init = await readText(path.join(roots[platform], commandPath[platform]('init')));
    if (platform === 'claude-code' || platform === 'cursor' || platform === 'opencode' || platform === 'pi')
      assert(init.includes('$ARGUMENTS'), `${platform} init did not preserve native argument substitution.`);
    else
      assert(init.includes('the arguments supplied with this explicit invocation'), `${platform} init did not explain transformed arguments.`);
    assert(init.includes('argument-hint: <target>') === (platform === 'claude-code' || platform === 'pi'), `${platform} init has the wrong argument hint representation.`);

    for (const agent of agents) {
      /** 当前 Platform 的原生 Agent 或 guidance fallback。 */
      const content = await readText(path.join(roots[platform], agentPath[platform](agent)));
      assert(content.includes(`description:`), `${platform} ${agent} Agent output is missing metadata.`);
      if (['antigravity', 'codex', 'pi'].includes(platform))
        assert(content.includes('Intended model class:') && content.includes('guidance'), `${platform} ${agent} fallback lost explicit limitations.`);
    }

    /** 当前 Platform 生成的规范 Skill 主文件。 */
    const skill = await readText(path.join(roots[platform], skillRoot[platform], 'SKILL.md'));
    assert(skill.includes('name: project-workflow'), `${platform} Skill is missing its generated name.`);
    assert(skill.includes('Project workflow capability template'), `${platform} Skill lost its canonical body.`);
    for (const auxiliary of skillAuxiliary) {
      /** Canonical Skill 辅助文件原始字节。 */
      const source = await fs.readFile(path.join(playground, 'src/skills/project-workflow', auxiliary));
      /** 当前 Platform 按 owner 复制的辅助文件字节。 */
      const generated = await fs.readFile(path.join(roots[platform], skillRoot[platform], auxiliary));
      assert(source.equals(generated), `${platform} changed Skill auxiliary ${auxiliary}.`);
    }

    /** Public 文件必须对所有交付单元执行逐字节复制。 */
    const publicFiles = await listFiles(path.join(playground, 'public'));
    for (const file of publicFiles) {
      /** 当前 Public 源文件的原始字节。 */
      const source = await fs.readFile(path.join(playground, 'public', file));
      /** 当前 Platform 复制后的 Public 文件字节。 */
      const generated = await fs.readFile(path.join(roots[platform], file));
      assert(source.equals(generated), `${platform} changed Public file ${file}.`);
    }
  }

  /** Claude Code 平台专属字段必须落入原生 Frontmatter。 */
  const claudeInit = await readText(path.join(roots['claude-code'], 'commands/init.md'));
  assert(claudeInit.includes('allowed-tools:') && claudeInit.includes('model: sonnet'), 'Claude Code Command options were not emitted.');
  /** Codex Skill 专属展示与 policy 字段必须落入 openai.yaml。 */
  const codexMetadata = await readText(path.join(roots.codex, 'skills/project-workflow/agents/openai.yaml'));
  assert(codexMetadata.includes('icon_small: ./assets/icon-small.svg'), 'Codex Skill metadata is missing icon_small.');
  assert(codexMetadata.includes('brand_color: "#FACC15"'), 'Codex Skill metadata is missing brand color.');
  assert(codexMetadata.includes('- CODEX'), 'Codex Skill metadata is missing products policy.');
  /** Cursor 只对纯读取 Agent 输出 readonly。 */
  const cursorInvestigator = await readText(path.join(roots.cursor, 'agents/investigator.md'));
  /** Cursor 中拥有写权限的 recorder Agent。 */
  const cursorRecorder = await readText(path.join(roots.cursor, 'agents/recorder.md'));
  assert(cursorInvestigator.includes('readonly: true'), 'Cursor read-only Agent did not preserve its capability boundary.');
  assert(!cursorRecorder.includes('readonly: true'), 'Cursor writable Agent was incorrectly marked read-only.');
  /** OpenCode 必须生成明确的工具和权限映射。 */
  const openCodeRecorder = await readText(path.join(roots.opencode, '.opencode/agents/recorder.md'));
  assert(openCodeRecorder.includes('edit: true') && openCodeRecorder.includes('bash: deny'), 'OpenCode Agent capability mapping is incorrect.');
}

/** 校验六个平台 Manifest/Config 与两个 Marketplace 分发物。 */
async function verifyManifestsAndDistributions() {
  /** Claude Code 插件清单。 */
  const claude = await readJson(path.join(outputRoot, 'claude-code/plugin/.claude-plugin/plugin.json'));
  assert(claude.commands === './commands/' && claude.skills === './skills/' && claude.agents === './agents/', 'Claude Code manifest has wrong Component references.');
  assert(claude.hooks === './hooks/hooks.json' && claude.mcpServers === './.mcp.json', 'Claude Code manifest has wrong Extension references.');
  assert(claude.defaultEnabled === false, 'Claude Code defaultEnabled option was not emitted.');
  /** Codex 插件清单。 */
  const codex = await readJson(path.join(outputRoot, 'codex/plugin/.codex-plugin/plugin.json'));
  assert(codex.skills === './skills/' && codex.hooks === './hooks/hooks.json' && codex.mcpServers === './.mcp.json', 'Codex manifest has wrong resource references.');
  assert(codex.interface.brandColor === '#FACC15' && codex.interface.logo === './assets/acplugin.svg', 'Codex interface options were not emitted.');
  /** Cursor 插件清单。 */
  const cursor = await readJson(path.join(outputRoot, 'cursor/plugin/.cursor-plugin/plugin.json'));
  assert(cursor.commands === './commands/*.md' && cursor.skills === './skills/*/SKILL.md' && cursor.agents === './agents/*.md', 'Cursor manifest has wrong Component globs.');
  assert(cursor.hooks === './hooks/hooks.json' && cursor.mcpServers === './mcp.json', 'Cursor manifest has wrong Extension references.');
  assert(cursor.logo === './assets/acplugin.svg' && cursor.minClientVersions.cursor === '1.0.0', 'Cursor Platform options were not emitted.');
  /** Antigravity 只允许已确认的最小 Manifest。 */
  const antigravity = await readJson(path.join(outputRoot, 'antigravity/plugin/plugin.json'));
  assert(JSON.stringify(antigravity) === '{"name":"acplugin-capability-playground"}', 'Antigravity manifest contains an unverified field.');
  /** OpenCode Workspace Config 由 schema 与 MCP add-only patch 组成。 */
  const openCode = await readJson(path.join(outputRoot, 'opencode/workspace/opencode.json'));
  assert(openCode.$schema === 'https://opencode.ai/config.json' && Object.keys(openCode.mcp).length === 4, 'OpenCode workspace config is incomplete.');
  /** Pi npm package 必须保持公开包边界并发现全部资源。 */
  const pi = await readJson(path.join(outputRoot, 'pi/package/package.json'));
  assert(pi.private === undefined && pi.workspaces === undefined, 'Pi package leaks workspace-only fields.');
  assert(JSON.stringify(pi.pi.extensions) === '["./extensions/acplugin-hooks.mjs"]', 'Pi package does not discover the Hooks Extension.');
  assert(pi.pi.image === './assets/acplugin.svg' && pi.pi.video.startsWith('https://'), 'Pi gallery options were not emitted.');
  assert(!Object.hasOwn(pi.pi, 'mcp'), 'Pi package fabricated unsupported MCP configuration.');

  /** Claude Code Marketplace 根清单。 */
  const claudeMarketplace = await readJson(path.join(outputRoot, 'claude-code/marketplace/.claude-plugin/marketplace.json'));
  assert(claudeMarketplace.name === 'acplugin-capability-playground-marketplace', 'Claude Code Marketplace has the wrong name.');
  assert(claudeMarketplace.plugins.length === 1 && claudeMarketplace.plugins[0].source === './' && claudeMarketplace.plugins[0].strict === true, 'Claude Code Marketplace source is not self-contained.');
  /** Codex Marketplace 根清单。 */
  const codexMarketplace = await readJson(path.join(outputRoot, 'codex/marketplace/.agents/plugins/marketplace.json'));
  assert(codexMarketplace.name === 'acplugin-capability-playground-marketplace', 'Codex Marketplace has the wrong name.');
  assert(codexMarketplace.plugins.length === 1 && codexMarketplace.plugins[0].source.path === './', 'Codex Marketplace source is not self-contained.');

  for (const platform of ['claude-code', 'codex']) {
    /** 当前 Platform 主 Plugin 的全部文件。 */
    const primaryRoot = path.join(outputRoot, platform, 'plugin');
    /** 当前 Platform 自包含 Marketplace 的全部文件。 */
    const marketplaceRoot = path.join(outputRoot, platform, 'marketplace');
    for (const file of await listFiles(primaryRoot)) {
      /** 主交付单元中的继承文件字节。 */
      const primary = await fs.readFile(path.join(primaryRoot, file));
      /** Marketplace 中对应文件的字节。 */
      const distributed = await fs.readFile(path.join(marketplaceRoot, file));
      assert(primary.equals(distributed), `${platform} Marketplace changed inherited Artifact ${file}.`);
    }
  }
}

/** 创建每个 Hook handler 使用的合法原生输入。 */
function hookInput(event) {
  /** 所有 Hook 输入共享的规范 snake_case 字段。 */
  const input = {
    session_id: 'playground-session',
    transcript_path: null,
    cwd: '.',
    hook_event_name: event,
  };
  if (event === 'SessionStart')
    return { ...input, source: 'startup' };
  if (event === 'SessionEnd')
    return { ...input, reason: 'complete' };
  if (event === 'UserPromptSubmit')
    return { ...input, prompt: 'Inspect the template.' };
  if (event === 'PreToolUse' || event === 'PermissionRequest')
    return { ...input, tool_name: 'Read', tool_input: { path: 'README.md' }, tool_use_id: 'tool-1' };
  if (event === 'PostToolUse')
    return { ...input, tool_name: 'Read', tool_input: { path: 'README.md' }, tool_use_id: 'tool-1', tool_response: { ok: true } };
  if (event === 'PreCompact' || event === 'PostCompact')
    return { ...input, trigger: 'manual' };
  if (event === 'SubagentStart')
    return { ...input, agent_id: 'agent-1', agent_type: 'investigator' };
  if (event === 'SubagentStop')
    return { ...input, agent_id: 'agent-1', agent_type: 'investigator', stop_hook_active: true };
  return { ...input, stop_hook_active: true, last_assistant_message: 'Done.' };
}

/** 校验 Hook 配置引用、支持矩阵、运行文件和真实 Handler/wire 协议。 */
async function verifyHooks() {
  /** 每个平台的 Hook 运行文件根。 */
  const hookRoots = {
    'antigravity': path.join(outputRoot, 'antigravity/plugin/hooks'),
    'claude-code': path.join(outputRoot, 'claude-code/plugin/hooks'),
    'codex': path.join(outputRoot, 'codex/plugin/hooks'),
    'cursor': path.join(outputRoot, 'cursor/plugin/hooks'),
    'opencode': path.join(outputRoot, 'opencode/workspace/.opencode/acplugin-hooks'),
    'pi': path.join(outputRoot, 'pi/package/extensions/acplugin-hooks'),
  };
  /** 可以检查引用闭包的 Platform 配置文本。 */
  const configurationText = {
    'antigravity': await readText(path.join(outputRoot, 'antigravity/plugin/hooks.json')),
    'claude-code': await readText(path.join(outputRoot, 'claude-code/plugin/hooks/hooks.json')),
    'codex': await readText(path.join(outputRoot, 'codex/plugin/hooks/hooks.json')),
    'cursor': await readText(path.join(outputRoot, 'cursor/plugin/hooks/hooks.json')),
    'opencode': await readText(path.join(outputRoot, 'opencode/workspace/.opencode/plugins/acplugin-hooks.mjs')),
    'pi': await readText(path.join(outputRoot, 'pi/package/extensions/acplugin-hooks.mjs')),
  };
  for (const platform of platforms) {
    for (const [id, event] of Object.entries(hookEvents)) {
      /** unsupported 事件不得留下 Handler、wire 或配置引用。 */
      const supported = hookEventLevels[platform][id] !== 'unsupported';
      /** 当前 Platform 中 handler 的绝对路径。 */
      const handler = path.join(hookRoots[platform], id, 'handler.mjs');
      /** 当前 Platform 中 wire profile 的绝对路径。 */
      const wire = path.join(hookRoots[platform], id, 'wire.mjs');
      assert(await exists(handler) === supported, `${platform} has wrong Handler presence for ${id}.`);
      assert(await exists(wire) === supported, `${platform} has wrong wire presence for ${id}.`);
      assert(configurationText[platform].includes(id) === supported, `${platform} has wrong Hook config reference for ${id}.`);
      if (!supported)
        continue;
      /** Handler 必须是可执行文件，wire 必须是普通只读数据代码。 */
      const handlerMode = (await fs.stat(handler)).mode & 0o777;
      /** 当前 wire 文件的权限位。 */
      const wireMode = (await fs.stat(wire)).mode & 0o777;
      assert(handlerMode === 0o755 && wireMode === 0o644, `${platform} ${id} has wrong runtime modes.`);
      /** 使用真实平台 wire 执行当前 Handler。 */
      const execution = await runProtocol(handler, [platform], JSON.stringify(hookInput(event)), {
        ANTIGRAVITY_PLUGIN_ROOT: hookRoots[platform],
        CLAUDE_PLUGIN_DATA: path.join(hookRoots[platform], '.data'),
        CLAUDE_PLUGIN_ROOT: hookRoots[platform],
        CURSOR_PLUGIN_ROOT: hookRoots[platform],
        PLUGIN_DATA: path.join(hookRoots[platform], '.data'),
        PLUGIN_ROOT: hookRoots[platform],
      });
      assert(execution.code === 0 && execution.stderr === '', `${platform} ${id} Handler failed its real wire protocol.`);
      if (execution.stdout.trim() !== '') {
        /** 平台需要显式 stdout 时，结果必须是可序列化对象。 */
        const output = JSON.parse(execution.stdout);
        assert(output !== null && typeof output === 'object' && !Array.isArray(output), `${platform} ${id} emitted a non-object result.`);
      }
    }
  }
}

/** 校验 HTTP/OAuth/Bearer/stdio MCP 映射与真实本地 Server 协议。 */
async function verifyMcp() {
  /** Claude Code 包装后的 MCP 清单。 */
  const claude = (await readJson(path.join(outputRoot, 'claude-code/plugin/.mcp.json'))).mcpServers;
  /** Codex 直接使用的 MCP 清单。 */
  const codex = await readJson(path.join(outputRoot, 'codex/plugin/.mcp.json'));
  /** Cursor 仅含远程服务的 MCP 清单。 */
  const cursor = (await readJson(path.join(outputRoot, 'cursor/plugin/mcp.json'))).mcpServers;
  /** Antigravity 仅含远程服务的 MCP 清单。 */
  const antigravity = (await readJson(path.join(outputRoot, 'antigravity/plugin/mcp_config.json'))).mcpServers;
  /** OpenCode 工作区中的 MCP 清单。 */
  const openCode = (await readJson(path.join(outputRoot, 'opencode/workspace/opencode.json'))).mcp;
  for (const descriptors of [claude, codex, cursor, antigravity, openCode]) {
    assert(descriptors['public-docs'].url === 'https://mcp.example.com/public-docs', 'Remote public MCP URL was mapped incorrectly.');
    assert(descriptors['oauth-docs'].url === 'https://mcp.example.com/oauth-docs', 'Remote OAuth MCP URL was mapped incorrectly.');
    assert(descriptors['protected-docs'].url === 'https://mcp.example.com/protected-docs', 'Remote Bearer MCP URL was mapped incorrectly.');
  }
  assert(claude['protected-docs'].headers.Authorization === 'Bearer ${PLAYGROUND_MCP_TOKEN}', 'Claude Code Bearer env reference is incorrect.');
  assert(codex['protected-docs'].bearer_token_env_var === 'PLAYGROUND_MCP_TOKEN', 'Codex Bearer env reference is incorrect.');
  assert(cursor['protected-docs'].headers.Authorization === 'Bearer ${env:PLAYGROUND_MCP_TOKEN}', 'Cursor Bearer env reference is incorrect.');
  assert(antigravity['protected-docs'].headers.Authorization === 'Bearer ${PLAYGROUND_MCP_TOKEN}', 'Antigravity Bearer env reference is incorrect.');
  assert(openCode['protected-docs'].headers.Authorization === 'Bearer {env:PLAYGROUND_MCP_TOKEN}', 'OpenCode Bearer env reference is incorrect.');
  assert(claude['oauth-docs'].oauth.scopes === 'resources:read templates:read', 'Claude Code OAuth scopes are incorrect.');
  assert(JSON.stringify(codex['oauth-docs'].scopes) === '["resources:read","templates:read"]', 'Codex OAuth scopes are incorrect.');
  assert(JSON.stringify(openCode['oauth-docs'].oauth.scopes) === '["resources:read","templates:read"]', 'OpenCode OAuth scopes are incorrect.');
  assert(cursor['oauth-docs'].scopes === undefined && antigravity['oauth-docs'].scopes === undefined, 'A degraded MCP adapter emitted unsupported OAuth scopes.');
  assert(claude['local-tools'].type === 'stdio' && codex['local-tools'].command === 'node' && openCode['local-tools'].type === 'local', 'Supported local MCP descriptors are incomplete.');
  assert(cursor['local-tools'] === undefined && antigravity['local-tools'] === undefined, 'Remote-only MCP adapter emitted local stdio configuration.');

  /** local stdio 只允许出现在三个拥有 portable root contract 的 Platform。 */
  const servers = [
    path.join(outputRoot, 'claude-code/plugin/mcp/local-tools/server.mjs'),
    path.join(outputRoot, 'codex/plugin/mcp/local-tools/server.mjs'),
    path.join(outputRoot, 'opencode/workspace/.opencode/mcp/local-tools/server.mjs'),
  ];
  assert(!await exists(path.join(outputRoot, 'cursor/plugin/mcp/local-tools/server.mjs')), 'Cursor emitted unsupported local MCP bundle.');
  assert(!await exists(path.join(outputRoot, 'antigravity/plugin/mcp/local-tools/server.mjs')), 'Antigravity emitted unsupported local MCP bundle.');
  assert(!await exists(path.join(outputRoot, 'pi/package/mcp')), 'Pi emitted unsupported MCP artifacts.');
  /** 三个平台必须复用同一平台中立 Bundle 字节。 */
  const serverBytes = await Promise.all(servers.map(file => fs.readFile(file)));
  assert(serverBytes[0].equals(serverBytes[1]) && serverBytes[0].equals(serverBytes[2]), 'Local MCP Server Bundle differs between supported Platforms.');
  for (const server of servers) {
    /** 当前本地 MCP Server Bundle 的权限位。 */
    const mode = (await fs.stat(server)).mode & 0o777;
    assert(mode === 0o755, 'Local MCP Server is not executable.');
    assert(!await exists(path.join(path.dirname(server), 'THIRD_PARTY_LICENSES.txt')), 'Dependency-free MCP Server emitted a spurious license inventory.');
    /** 同时覆盖 initialize、notifications/initialized、tools/list 和 tools/call。 */
    const input = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'playground-verifier', version: '1.0.0' } },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'inspect-template', arguments: {} } }),
      '',
    ].join('\n');
    /** 真实安装 Bundle 的 JSON-RPC 响应。 */
    const execution = await runProtocol(server, [], input);
    assert(execution.code === 0 && execution.stderr === '', 'Local MCP Server failed its real protocol smoke.');
    /** 按 JSON Lines 协议解析的三条响应。 */
    const responses = execution.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert(responses.length === 3, 'Local MCP Server emitted an unexpected response count.');
    assert(responses[0].result.serverInfo.name === 'acplugin-playground', 'Local MCP initialize response is incorrect.');
    assert(responses[1].result.tools[0].name === 'inspect-template', 'Local MCP tools/list response is incorrect.');
    assert(responses[2].result.content[0].text.includes('static ACPlugin capability template'), 'Local MCP tools/call response is incorrect.');
  }
}

/** 扫描稳定报告与所有生成文件，拒绝绝对路径和 Secret 值泄漏。 */
async function verifyStableOutputSafety(report) {
  /** 报告不得包含宿主路径或构建期 Secret 值。 */
  const serializedReport = JSON.stringify(report);
  assert(!serializedReport.includes(playground), 'Playground report leaks its absolute project path.');
  assert(!serializedReport.includes(secretMarker), 'Playground report leaks a build-time Secret value.');
  for (const file of await listFiles(outputRoot)) {
    /** 当前输出全部是可安全按 UTF-8 扫描的 JSON/Markdown/ESM/SVG 文本。 */
    const content = await readText(path.join(outputRoot, file));
    assert(!content.includes(playground), `Generated file ${file} leaks its absolute project path.`);
    assert(!content.includes(secretMarker), `Generated file ${file} leaks a build-time Secret value.`);
  }
}

/** 运行完整 Playground validate、双 build、内容协议和确定性检查。 */
async function main() {
  /** 真实 validate 产生但不提交的完整 BuildResult。 */
  const validation = await runCli('validate');
  verifyReport(validation, 'validate');
  /** 第一次真实 build 负责提交随后检查的六平台输出。 */
  const firstBuild = await runCli('build');
  verifyReport(firstBuild, 'build');
  /** validate/build 除命令和提交状态外必须拥有相同的稳定结构。 */
  for (const field of ['compatibility', 'diagnostics', 'documents', 'extensions', 'metadata', 'platformDetails', 'platforms'])
    assert(JSON.stringify(validation[field]) === JSON.stringify(firstBuild[field]), `validate/build differ in stable report field ${field}.`);
  /** command 会改变临时 Hook workDir，但不能改变交付结构、size、mode 或 owner。 */
  const deliveryShape = report => report.deliveryUnits.map(unit => ({
    platform: unit.platform,
    id: unit.id,
    role: unit.role,
    type: unit.type,
    artifacts: unit.artifacts.map(({ sha256: _sha256, ...artifact }) => artifact),
  }));
  assert(JSON.stringify(deliveryShape(validation)) === JSON.stringify(deliveryShape(firstBuild)), 'validate/build differ in DeliveryUnit structure.');
  await verifyArtifactClosure(firstBuild);
  await verifyCanonicalOutputs();
  await verifyManifestsAndDistributions();
  await verifyHooks();
  await verifyMcp();
  await verifyStableOutputSafety(firstBuild);

  /** 第一次构建后完整产物树的权限与字节快照。 */
  const firstSnapshot = await snapshotOutput();
  /** 第二次相同输入构建用于验证事务替换后的字节确定性。 */
  const secondBuild = await runCli('build');
  assert(JSON.stringify(firstBuild) === JSON.stringify(secondBuild), 'Repeated Playground build report is not byte-stable JSON.');
  /** 第二次构建后完整产物树的权限与字节快照。 */
  const secondSnapshot = await snapshotOutput();
  assert(JSON.stringify(firstSnapshot) === JSON.stringify(secondSnapshot), 'Repeated Playground build changed output bytes or modes.');
}

await main();
