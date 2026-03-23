import * as path from 'path';
import { readFile, listFiles, listDirs, listFilesRecursive } from '../utils/fs.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import type { ScanResult, Skill, SkillFrontmatter, SkillAuxFile, Instruction, MCPConfig, MCPServer, Agent, AgentFrontmatter, Command, Hooks } from '../types.js';

/**
 * Scan a Claude Code project directory (.claude/ structure).
 */
export function scanClaudeProject(rootDir: string): ScanResult {
  return {
    skills: scanSkillsDir(path.join(rootDir, '.claude', 'skills')),
    instructions: scanInstructions(rootDir),
    mcp: scanMCPJson(path.join(rootDir, '.mcp.json')),
    agents: scanAgentsDir(path.join(rootDir, '.claude', 'agents')),
    commands: scanCommandsDir(path.join(rootDir, '.claude', 'commands')),
    hooks: scanSettingsHooks(path.join(rootDir, '.claude', 'settings.json')),
    rootDir,
  };
}

// --- Reusable scanning functions (also used by plugin scanner) ---

export function scanSkillsDir(skillsDir: string): Skill[] {
  const skills: Skill[] = [];
  for (const dir of listDirs(skillsDir)) {
    const skillFile = path.join(dir, 'SKILL.md');
    const content = readFile(skillFile);
    if (!content) continue;
    const auxFiles = scanSkillAuxFiles(dir);
    try {
      const { data, body } = parseFrontmatter<SkillFrontmatter>(content);
      skills.push({
        dirName: path.basename(dir),
        frontmatter: data,
        body,
        sourcePath: skillFile,
        auxFiles,
      });
    } catch {
      // Skip files with invalid frontmatter
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
 * Scan all auxiliary files in a skill directory (everything except SKILL.md).
 * Includes files in subdirectories like references/, scripts/, assets/.
 */
function scanSkillAuxFiles(skillDir: string): SkillAuxFile[] {
  const allFiles = listFilesRecursive(skillDir);
  const auxFiles: SkillAuxFile[] = [];
  for (const file of allFiles) {
    const relativePath = path.relative(skillDir, file);
    if (relativePath === 'SKILL.md') continue;
    const content = readFile(file);
    if (content !== null) {
      auxFiles.push({ relativePath, content });
    }
  }
  return auxFiles;
}

export function scanAgentsDir(agentsDir: string): Agent[] {
  const agents: Agent[] = [];
  for (const file of listFiles(agentsDir, '\\.md$')) {
    const content = readFile(file);
    if (!content) continue;
    try {
      const { data, body } = parseFrontmatter<AgentFrontmatter>(content);
      agents.push({
        fileName: path.basename(file, '.md'),
        frontmatter: data,
        body,
        sourcePath: file,
      });
    } catch {
      // Skip files with invalid frontmatter
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

export function scanCommandsDir(commandsDir: string): Command[] {
  const commands: Command[] = [];
  for (const file of listFiles(commandsDir, '\\.md$')) {
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

export function scanMCPJson(mcpPath: string): MCPConfig | null {
  const content = readFile(mcpPath);
  if (!content) return null;

  try {
    const data = JSON.parse(content);
    const mcpServers = data.mcpServers || {};
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

export function scanSettingsHooks(settingsPath: string): Hooks | null {
  const content = readFile(settingsPath);
  if (!content) return null;

  try {
    const data = JSON.parse(content);
    return data.hooks || null;
  } catch {
    return null;
  }
}

export function scanHooksJson(hooksJsonPath: string): Hooks | null {
  const content = readFile(hooksJsonPath);
  if (!content) return null;

  try {
    const data = JSON.parse(content);
    return data.hooks || null;
  } catch {
    return null;
  }
}

function scanInstructions(rootDir: string): Instruction[] {
  const instructions: Instruction[] = [];

  for (const name of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    const filePath = path.join(rootDir, name);
    const content = readFile(filePath);
    if (content) {
      instructions.push({ fileName: path.basename(name), content, sourcePath: filePath, isRule: false });
    }
  }

  const rulesDir = path.join(rootDir, '.claude', 'rules');
  for (const file of listFiles(rulesDir, '\\.md$')) {
    const content = readFile(file);
    if (content) {
      instructions.push({ fileName: path.basename(file), content, sourcePath: file, isRule: true });
    }
  }

  return instructions;
}
