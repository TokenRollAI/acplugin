import * as path from 'path';
import { readFile, listFiles, listDirs, listFilesRecursive } from '../utils/fs.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import type { ScanResult, Skill, SkillFrontmatter, SkillAuxFile, Instruction, MCPConfig, MCPServer, Agent, AgentFrontmatter, Command, Hooks } from '../types.js';

/**
 * 扫描旧 Claude Code 工程的 `.claude/` 结构和根级配置。
 *
 * @param rootDir 旧工程根目录。
 * @returns 供隔离迁移层消费的宽松 ScanResult。
 */
export function scanClaudeProject(rootDir: string): ScanResult {
  /** Claude Project 固定的旧 Hooks 配置文件。 */
  const hooksSourcePath = path.join(rootDir, '.claude', 'settings.json');
  /** 从 Settings 中容错读取的 Hooks 映射。 */
  const hooks = scanSettingsHooks(hooksSourcePath);
  return {
    skills: scanSkillsDir(path.join(rootDir, '.claude', 'skills')),
    instructions: scanInstructions(rootDir),
    mcp: scanMCPJson(path.join(rootDir, '.mcp.json')),
    agents: scanAgentsDir(path.join(rootDir, '.claude', 'agents')),
    commands: scanCommandsDir(path.join(rootDir, '.claude', 'commands')),
    hooks,
    ...(hooks === null ? {} : { hooksSourcePath }),
    pluginFiles: [],
    rootDir,
  };
}

// 以下宽松扫描函数也由旧 Plugin Scanner 复用。

/**
 * 扫描一级 Skill 目录，并对不规范 Frontmatter 采用保留正文的容错策略。
 *
 * @param skillsDir 旧 Skills 根目录。
 * @returns 成功读取的旧 Skill 列表。
 */
export function scanSkillsDir(skillsDir: string): Skill[] {
  /** 当前目录累计发现的旧 Skills。 */
  const skills: Skill[] = [];
  for (const dir of listDirs(skillsDir)) {
    /** 当前旧 Skill 的主 Markdown 路径。 */
    const skillFile = path.join(dir, 'SKILL.md');
    /** 主 Markdown 内容；缺失或读取失败时跳过该目录。 */
    const content = readFile(skillFile);
    if (!content) continue;
    /** 无论 Frontmatter 是否有效都需要保留的辅助文件。 */
    const auxFiles = scanSkillAuxFiles(dir);
    try {
      /** 成功解析的旧 Skill Frontmatter 与正文。 */
      const { data, body } = parseFrontmatter<SkillFrontmatter>(content);
      skills.push({
        dirName: path.basename(dir),
        frontmatter: data,
        body,
        sourcePath: skillFile,
        auxFiles,
      });
    } catch {
      // Frontmatter 无效时保留完整原文，让迁移报告标记降级而非丢弃资源。
      skills.push({
        dirName: path.basename(dir),
        frontmatter: {},
        body: content,
        sourcePath: skillFile,
        auxFiles,
      });
    }
  }
  return skills;
}

/**
 * 递归扫描 Skill 目录中除 SKILL.md 外的全部辅助文件。
 *
 * @param skillDir 单个旧 Skill 根目录。
 * @returns references、scripts、assets 等子目录中的辅助文件。
 */
function scanSkillAuxFiles(skillDir: string): SkillAuxFile[] {
  /** 旧 Skill 目录下递归发现的全部文件。 */
  const allFiles = listFilesRecursive(skillDir);
  /** 排除主文件后保留的辅助文件。 */
  const auxFiles: SkillAuxFile[] = [];
  for (const file of allFiles) {
    /** 当前文件相对于旧 Skill 根目录的路径。 */
    const relativePath = path.relative(skillDir, file);
    if (relativePath === 'SKILL.md') continue;
    // 辅助文件可能是图片、压缩包或其他二进制内容，只记录可信来源路径，迁移阶段按字节复制。
    auxFiles.push({ relativePath, sourcePath: file });
  }
  return auxFiles;
}

/**
 * 扫描一级 Agent Markdown，并对无效 Frontmatter 保留完整正文。
 *
 * @param agentsDir 旧 Agents 根目录。
 * @returns 成功读取的旧 Agent 列表。
 */
export function scanAgentsDir(agentsDir: string): Agent[] {
  /** 当前目录累计发现的旧 Agents。 */
  const agents: Agent[] = [];
  for (const file of listFiles(agentsDir, '\\.md$')) {
    /** 当前旧 Agent Markdown 的完整内容。 */
    const content = readFile(file);
    if (!content) continue;
    try {
      /** 成功解析的旧 Agent Frontmatter 与正文。 */
      const { data, body } = parseFrontmatter<AgentFrontmatter>(content);
      agents.push({
        fileName: path.basename(file, '.md'),
        frontmatter: data,
        body,
        sourcePath: file,
      });
    } catch {
      // Frontmatter 无效时仍保留资源，交由迁移层报告降级。
      agents.push({
        fileName: path.basename(file, '.md'),
        frontmatter: {},
        body: content,
        sourcePath: file,
      });
    }
  }
  return agents;
}

/**
 * 扫描一级 Command Markdown，延后到迁移阶段解析其 Frontmatter。
 *
 * @param commandsDir 旧 Commands 根目录。
 * @returns 成功读取的完整 Command 文件。
 */
export function scanCommandsDir(commandsDir: string): Command[] {
  /** 当前目录累计发现的旧 Commands。 */
  const commands: Command[] = [];
  for (const file of listFiles(commandsDir, '\\.md$')) {
    /** 当前旧 Command Markdown 的完整内容。 */
    const content = readFile(file);
    if (!content) continue;
    commands.push({
      name: path.basename(file, '.md'),
      content,
      sourcePath: file,
    });
  }
  return commands;
}

/**
 * 容错读取旧 `.mcp.json`，并把名称映射展开为 Server 列表。
 *
 * @param mcpPath 旧 MCP 配置路径。
 * @returns JSON 可解析时的宽松配置，否则返回 null。
 */
export function scanMCPJson(mcpPath: string): MCPConfig | null {
  /** 旧 MCP JSON 原文。 */
  const content = readFile(mcpPath);
  if (!content) return null;

  try {
    /** 未经 Schema 验证的旧 JSON 对象。 */
    const data = JSON.parse(content);
    /** 旧格式中 Server 名称到配置的映射。 */
    const mcpServers = data.mcpServers || {};
    /** 注入映射键作为 name 后的宽松 Server 列表。 */
    const servers: MCPServer[] = Object.entries(mcpServers).map(([name, config]: [string, any]) => ({
      name,
      command: config.command,
      args: config.args,
      env: config.env,
      type: config.type,
      url: config.url,
      headers: config.headers,
    }));
    return { servers, sourcePath: mcpPath };
  } catch {
    return null;
  }
}

/**
 * 从旧 `.claude/settings.json` 中容错提取 Hooks 字段。
 *
 * @param settingsPath 旧 Settings 路径。
 * @returns Hooks 映射，文件缺失或 JSON 无效时返回 null。
 */
export function scanSettingsHooks(settingsPath: string): Hooks | null {
  /** 旧 Settings JSON 原文。 */
  const content = readFile(settingsPath);
  if (!content) return null;

  try {
    /** 旧 Settings 解析出的未知 JSON 对象。 */
    const data = JSON.parse(content);
    return data.hooks || null;
  } catch {
    return null;
  }
}

/**
 * 从旧 Plugin `hooks.json` 中容错提取 Hooks 字段。
 *
 * @param hooksJsonPath 旧 Hooks JSON 路径。
 * @returns Hooks 映射，文件缺失或 JSON 无效时返回 null。
 */
export function scanHooksJson(hooksJsonPath: string): Hooks | null {
  /** 旧 Hooks JSON 原文。 */
  const content = readFile(hooksJsonPath);
  if (!content) return null;

  try {
    /** 旧 hooks.json 解析出的未知 JSON 对象。 */
    const data = JSON.parse(content);
    return data.hooks || null;
  } catch {
    return null;
  }
}

/**
 * 扫描根级 CLAUDE.md 和 `.claude/rules/*.md`。
 *
 * Instructions 不会自动进入规范 Plugin，只用于未映射保留和报告。
 *
 * @param rootDir 旧工程根目录。
 * @returns 所有可读旧 Instructions。
 */
function scanInstructions(rootDir: string): Instruction[] {
  /** 当前工程累计发现的旧 Instructions。 */
  const instructions: Instruction[] = [];

  for (const name of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    /** 当前 CLAUDE.md 候选文件绝对路径。 */
    const filePath = path.join(rootDir, name);
    /** 当前候选 Instruction 的可选文本内容。 */
    const content = readFile(filePath);
    if (content) {
      instructions.push({ fileName: path.basename(name), content, sourcePath: filePath, isRule: false });
    }
  }

  /** `.claude/rules` 旧规则目录。 */
  const rulesDir = path.join(rootDir, '.claude', 'rules');
  for (const file of listFiles(rulesDir, '\\.md$')) {
    /** 当前旧 Rule Markdown 的可选文本内容。 */
    const content = readFile(file);
    if (content) {
      instructions.push({ fileName: path.basename(file), content, sourcePath: file, isRule: true });
    }
  }

  return instructions;
}
