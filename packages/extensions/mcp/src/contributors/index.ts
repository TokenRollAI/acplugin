import type { PlatformContributor } from '@tokenroll/acplugin/sdk';
import type { BuiltMcpServers } from '../build.js';
import { antigravityContributor } from './antigravity.js';
import { claudeCodeContributor } from './claude-code.js';
import { codexContributor } from './codex.js';
import { cursorContributor } from './cursor.js';
import { openCodeContributor } from './opencode.js';
import { piContributor } from './pi.js';

/** @returns 六个互不观察、只消费同一 MCP Built State 的官方 Contributors。 */
export function createMcpContributors(): readonly PlatformContributor<BuiltMcpServers>[] {
  return Object.freeze([
    claudeCodeContributor,
    codexContributor,
    cursorContributor,
    antigravityContributor,
    openCodeContributor,
    piContributor,
  ]);
}
