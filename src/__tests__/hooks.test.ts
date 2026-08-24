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
  it('degrades PreCompact to a codex note instead of skipping it', () => {
    const hooks: Hooks = {
      PreCompact: [{ hooks: [{ type: 'command', command: 'npx --no-install llmdoc hook compact' }] }],
    };
    const result = convertHooks(hooks, 'codex');
    const note = result.converted.find(f => f.content.includes('PreCompact'));
    expect(note).toBeDefined();
    expect(note!.content).toContain('Right before context compaction');
    expect(note!.content).toContain('npx --no-install llmdoc hook compact');
    expect(result.warnings.find(w => w.includes('PreCompact'))).toBeUndefined();
  });

  it('uses event-appropriate timing phrases in degraded notes', () => {
    const result = convertHooks(sampleHooks, 'codex');
    const sessionStart = result.converted.find(f => f.content.includes('SessionStart'));
    expect(sessionStart!.content).toContain('At the start of every session');
    expect(sessionStart!.content).not.toContain('Run after SessionStart');
  });

  it('converts portable command hooks to codex notes', () => {
    const result = convertHooks(sampleHooks, 'codex');
    expect(result.converted.length).toBeGreaterThan(0);
    const postToolUse = result.converted.find(f => f.content.includes('PostToolUse'));
    expect(postToolUse).toBeDefined();
    expect(postToolUse!.content).toContain('npx prettier --write');
  });

  it('warns about non-portable events', () => {
    const result = convertHooks(sampleHooks, 'codex');
    const subagentWarning = result.warnings.find(w => w.includes('SubagentStart'));
    expect(subagentWarning).toBeDefined();
  });

  it('warns about non-portable events with non-command hook types', () => {
    const result = convertHooks(sampleHooks, 'codex');
    // SubagentStart is not portable, so it gets skipped with a warning about the event
    const warning = result.warnings.find(w => w.includes('SubagentStart') && w.includes('not portable'));
    expect(warning).toBeDefined();
  });

  it('cannot convert hooks to cursor', () => {
    const result = convertHooks(sampleHooks, 'cursor');
    // Cursor doesn't support file-based hooks, should warn
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
