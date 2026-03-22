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
