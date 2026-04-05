import type { Hooks, Platform, ConvertedFile } from '../types.js';

// Events that have reasonable mapping across platforms
const PORTABLE_EVENTS = ['PostToolUse', 'PreToolUse', 'Stop', 'SessionStart'];

// Claude Code PascalCase → Cursor camelCase event name mapping
const CURSOR_EVENT_MAP: Record<string, string> = {
  'PostToolUse': 'postToolUse',
  'PreToolUse': 'preToolUse',
  'Stop': 'stop',
  'SessionStart': 'sessionStart',
};

interface HookReport {
  converted: ConvertedFile[];
  warnings: string[];
}

export function convertHooks(hooks: Hooks, platform: Platform): HookReport {
  if (platform === 'cursor') {
    return convertCursorHooks(hooks);
  }

  const warnings: string[] = [];
  const converted: ConvertedFile[] = [];

  for (const [event, matchers] of Object.entries(hooks)) {
    if (!PORTABLE_EVENTS.includes(event)) {
      warnings.push(`Hook event "${event}" is not portable to ${platform} — skipped`);
      continue;
    }

    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        if (hook.type === 'command' && hook.command) {
          const result = convertCommandHook(event, matcher.matcher, hook.command, platform);
          if (result) {
            converted.push(result);
          } else {
            warnings.push(`Hook ${event}/${matcher.matcher || '*'} cannot be directly converted to ${platform}`);
          }
        } else if (hook.type === 'prompt' || hook.type === 'agent') {
          warnings.push(`Hook type "${hook.type}" for event "${event}" is Claude Code specific — cannot convert to ${platform}`);
        } else if (hook.type === 'http') {
          warnings.push(`HTTP hook for event "${event}" — manual configuration needed for ${platform}`);
        }
      }
    }
  }

  return { converted, warnings };
}

/**
 * Convert Claude Code hooks to Cursor hooks format.
 * Cursor hooks use camelCase event names, no matcher, and a version field.
 */
function convertCursorHooks(hooks: Hooks): HookReport {
  const warnings: string[] = [];
  const cursorHooks: Record<string, Array<{ command: string }>> = {};

  for (const [event, matchers] of Object.entries(hooks)) {
    const cursorEvent = CURSOR_EVENT_MAP[event];
    if (!cursorEvent) {
      warnings.push(`Hook event "${event}" is not supported in Cursor — skipped`);
      continue;
    }

    const entries: Array<{ command: string }> = [];
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        if (hook.type === 'command' && hook.command) {
          // Strip ${CLAUDE_PLUGIN_ROOT}/ prefix and adapt path for Cursor
          let cmd = hook.command;
          cmd = cmd.replace(/"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/g, './$1');
          cmd = cmd.replace(/\$\{CLAUDE_PLUGIN_ROOT\}\//g, './');
          entries.push({ command: cmd });
        } else {
          warnings.push(`Hook type "${hook.type}" for event "${event}" is not supported in Cursor — skipped`);
        }
      }
    }

    if (entries.length > 0) {
      cursorHooks[cursorEvent] = entries;
    }
  }

  const converted: ConvertedFile[] = [];
  if (Object.keys(cursorHooks).length > 0) {
    const content = JSON.stringify({ version: 1, hooks: cursorHooks }, null, 2);
    converted.push({
      path: 'hooks.json',
      content,
      type: 'hook',
    });
  }

  return { converted, warnings };
}

function convertCommandHook(
  event: string,
  matcher: string | undefined,
  command: string,
  platform: Platform
): ConvertedFile | null {
  switch (platform) {
    case 'cursor':
      // Cursor doesn't have hooks yet in a config file format we can write
      return null;
    case 'codex':
      // Codex doesn't have hooks — add as a note in AGENTS.md
      return {
        path: `AGENTS.md.hook-${event}`,
        content: `## Hook: ${event}${matcher ? ` (${matcher})` : ''}\n\nRun after ${event}: \`${command}\`\n`,
        type: 'hook',
      };
    case 'opencode':
      // OpenCode doesn't have a public hooks system — add as a note
      return {
        path: `AGENTS.md.hook-${event}`,
        content: `## Hook: ${event}${matcher ? ` (${matcher})` : ''}\n\nRun after ${event}: \`${command}\`\n`,
        type: 'hook',
      };
    case 'antigravity':
      // Antigravity doesn't have file-configurable hooks
      return null;
  }
}
