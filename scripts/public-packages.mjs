/** Main public facade package used by every official Integration peer. */
export const mainPublicPackageName = '@tokenroll/acplugin';

/** Stable manifest order for the independently versioned public package ecosystem. */
export const publicPackageManifestPaths = Object.freeze([
  'packages/acplugin/package.json',
  'packages/platforms/claude-code/package.json',
  'packages/platforms/codex/package.json',
  'packages/platforms/cursor/package.json',
  'packages/platforms/antigravity/package.json',
  'packages/platforms/opencode/package.json',
  'packages/platforms/pi/package.json',
  'packages/extensions/hooks/package.json',
  'packages/extensions/mcp/package.json',
]);
