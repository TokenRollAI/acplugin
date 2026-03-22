import TOML from '@iarna/toml';

export function toToml(data: Record<string, unknown>): string {
  return TOML.stringify(data as any);
}

export function parseToml(content: string): Record<string, unknown> {
  return TOML.parse(content) as Record<string, unknown>;
}
