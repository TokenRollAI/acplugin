import type { PlatformContributor } from '@tokenroll/acplugin/sdk';
import type { BuiltHooks } from '../build.js';
import { antigravityContributor } from './antigravity.js';
import { claudeCodeContributor } from './claude-code.js';
import { codexContributor } from './codex.js';
import { cursorContributor } from './cursor.js';
import { openCodeContributor } from './opencode.js';
import { piContributor } from './pi.js';

/** @returns 六个互不观察、只消费同一 Built State 的官方 Contributors。 */
export function createHooksContributors(): readonly PlatformContributor<BuiltHooks>[] {
  return Object.freeze([
    claudeCodeContributor,
    codexContributor,
    cursorContributor,
    antigravityContributor,
    openCodeContributor,
    piContributor,
  ]);
}
