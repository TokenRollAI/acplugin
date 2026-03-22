import { describe, it, expect } from 'vitest';
import { parseGitHubSource } from '../github.js';

describe('parseGitHubSource', () => {
  it('parses github:owner/repo', () => {
    const result = parseGitHubSource('github:anthropics/claude-code');
    expect(result.owner).toBe('anthropics');
    expect(result.repo).toBe('claude-code');
    expect(result.branch).toBeUndefined();
  });

  it('parses github:owner/repo#branch', () => {
    const result = parseGitHubSource('github:anthropics/claude-code#main');
    expect(result.owner).toBe('anthropics');
    expect(result.repo).toBe('claude-code');
    expect(result.branch).toBe('main');
  });

  it('parses owner/repo shorthand', () => {
    const result = parseGitHubSource('anthropics/claude-code');
    expect(result.owner).toBe('anthropics');
    expect(result.repo).toBe('claude-code');
  });

  it('parses owner/repo#branch shorthand', () => {
    const result = parseGitHubSource('anthropics/claude-code#dev');
    expect(result.owner).toBe('anthropics');
    expect(result.repo).toBe('claude-code');
    expect(result.branch).toBe('dev');
  });

  it('parses full GitHub URL', () => {
    const result = parseGitHubSource('https://github.com/anthropics/claude-code');
    expect(result.owner).toBe('anthropics');
    expect(result.repo).toBe('claude-code');
    expect(result.branch).toBeUndefined();
  });

  it('parses GitHub URL with branch', () => {
    const result = parseGitHubSource('https://github.com/anthropics/claude-code/tree/main');
    expect(result.owner).toBe('anthropics');
    expect(result.repo).toBe('claude-code');
    expect(result.branch).toBe('main');
  });

  it('parses GitHub URL with branch and subpath', () => {
    const result = parseGitHubSource('https://github.com/anthropics/claude-code/tree/main/skills/my-skill');
    expect(result.owner).toBe('anthropics');
    expect(result.repo).toBe('claude-code');
    expect(result.branch).toBe('main');
    expect(result.subPath).toBe('skills/my-skill');
  });

  it('strips .git suffix from URL', () => {
    const result = parseGitHubSource('https://github.com/anthropics/claude-code.git');
    expect(result.repo).toBe('claude-code');
  });

  it('throws on invalid source', () => {
    expect(() => parseGitHubSource('invalid')).toThrow('Invalid GitHub source');
  });
});
