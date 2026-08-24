import { describe, it, expect } from 'vitest';
import { convertHooks } from '../converter/hooks.js';
import type { Hooks } from '../types.js';

const sampleHooks: Hooks = {
  PostToolUse: [
    {
      matcher: 'Edit|Write',
      hooks: [{ type: 'command', command: 'npx prettier --write' }],
    },
  ],
  SessionStart: [
    {
      hooks: [{ type: 'command', command: 'echo hello' }],
    },
  ],
  SubagentStart: [
    {
      hooks: [{ type: 'prompt', command: 'check something' }],
    },
  ],
};

describe('convertHooks', () => {
  it('passes hooks through natively for codex as hooks/hooks.json', () => {
    const hooks: Hooks = {
      PreCompact: [{ hooks: [{ type: 'command', command: 'npx --no-install llmdoc hook compact', additionalContextLimit: 300 } as never] }],
    };
    const result = convertHooks(hooks, 'codex');
    expect(result.converted).toHaveLength(1);
    const file = result.converted[0];
    expect(file.path).toBe('hooks/hooks.json');
    const parsed = JSON.parse(file.content) as { hooks: Hooks };
    expect(parsed.hooks.PreCompact[0].hooks[0].command).toBe('npx --no-install llmdoc hook compact');
    // fields beyond HookEntry's declared type survive the passthrough
    expect((parsed.hooks.PreCompact[0].hooks[0] as { additionalContextLimit?: number }).additionalContextLimit).toBe(300);
    expect(result.warnings.some(w => w.includes('review and trust'))).toBe(true);
  });

  it('keeps codex-native events like SubagentStart in the passthrough without warnings', () => {
    const result = convertHooks(sampleHooks, 'codex');
    const parsed = JSON.parse(result.converted[0].content) as { hooks: Hooks };
    expect(parsed.hooks.SubagentStart).toBeDefined();
    expect(result.warnings.find(w => w.includes('SubagentStart'))).toBeUndefined();
  });

  it('degrades PreCompact to an opencode note with event-appropriate phrasing', () => {
    const hooks: Hooks = {
      PreCompact: [{ hooks: [{ type: 'command', command: 'npx --no-install llmdoc hook compact' }] }],
    };
    const result = convertHooks(hooks, 'opencode');
    const note = result.converted.find(f => f.content.includes('PreCompact'));
    expect(note).toBeDefined();
    expect(note!.content).toContain('Right before context compaction');
    expect(result.warnings.find(w => w.includes('PreCompact'))).toBeUndefined();
  });

  it('uses event-appropriate timing phrases in degraded opencode notes', () => {
    const result = convertHooks(sampleHooks, 'opencode');
    const sessionStart = result.converted.find(f => f.content.includes('SessionStart'));
    expect(sessionStart!.content).toContain('At the start of every session');
    expect(sessionStart!.content).not.toContain('Run after SessionStart');
  });

  it('converts portable command hooks to opencode notes', () => {
    const result = convertHooks(sampleHooks, 'opencode');
    expect(result.converted.length).toBeGreaterThan(0);
    const postToolUse = result.converted.find(f => f.content.includes('PostToolUse'));
    expect(postToolUse).toBeDefined();
    expect(postToolUse!.content).toContain('npx prettier --write');
  });

  it('warns about non-portable events on opencode', () => {
    const result = convertHooks(sampleHooks, 'opencode');
    const subagentWarning = result.warnings.find(w => w.includes('SubagentStart'));
    expect(subagentWarning).toBeDefined();
  });

  it('warns about non-portable events with non-command hook types on opencode', () => {
    const result = convertHooks(sampleHooks, 'opencode');
    const warning = result.warnings.find(w => w.includes('SubagentStart') && w.includes('not portable'));
    expect(warning).toBeDefined();
  });

  it('cannot convert hooks to cursor', () => {
    const result = convertHooks(sampleHooks, 'cursor');
    // Cursor doesn't support file-based hooks, should warn
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
