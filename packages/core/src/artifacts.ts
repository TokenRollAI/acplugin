import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Artifact, ArtifactInput, ArtifactMode } from './types.js';

function normalizeArtifactPath(value: string): string {
  if (value.includes('\\'))
    throw new Error(`Artifact path must use POSIX separators: ${value}`);
  if (path.posix.isAbsolute(value))
    throw new Error(`Artifact path must be relative: ${value}`);
  const normalized = path.posix.normalize(value).normalize('NFC');
  if (normalized === '.' || normalized === '' || normalized === '..' || normalized.startsWith('../'))
    throw new Error(`Artifact path escapes the target root: ${value}`);
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => {
      size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), size };
}

export class ArtifactGraph {
  readonly #artifacts = new Map<string, Artifact>();
  readonly #normalizedPaths = new Map<string, string>();
  readonly #allowedSourceRoots: readonly string[];

  constructor(allowedSourceRoots: readonly string[]) {
    this.#allowedSourceRoots = allowedSourceRoots.map(root => path.resolve(root));
  }

  get artifacts(): readonly Artifact[] {
    return [...this.#artifacts.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  }

  async add(owner: string, input: ArtifactInput): Promise<Artifact> {
    const artifactPath = normalizeArtifactPath(input.path);
    const collisionKey = artifactPath.toLocaleLowerCase('en-US').normalize('NFC');
    const existingPath = this.#normalizedPaths.get(collisionKey);
    if (existingPath)
      throw new Error(`Artifact collision between "${existingPath}" and "${artifactPath}".`);

    const mode: ArtifactMode = input.mode ?? 0o644;
    if (mode !== 0o644 && mode !== 0o755)
      throw new Error(`Unsupported Artifact mode for ${artifactPath}.`);

    let size: number;
    let sha256: string;
    let source: Artifact['source'];
    if (input.source.type === 'bytes') {
      const value = Uint8Array.from(input.source.value);
      size = value.byteLength;
      sha256 = createHash('sha256').update(value).digest('hex');
      source = Object.freeze({ type: 'bytes', value });
    } else {
      const sourcePath = path.resolve(input.source.path);
      if (!this.#allowedSourceRoots.some(root => isInside(root, sourcePath)))
        throw new Error(`Artifact source is outside allowed roots: ${input.source.path}`);
      const stat = await fs.lstat(sourcePath);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(`Artifact source must be a regular non-symlink file: ${input.source.path}`);
      ({ size, sha256 } = await hashFile(sourcePath));
      source = Object.freeze({ type: 'file', path: sourcePath });
    }

    const artifact: Artifact = Object.freeze({
      path: artifactPath,
      source,
      owner,
      mode,
      size,
      sha256,
    });
    this.#artifacts.set(artifactPath, artifact);
    this.#normalizedPaths.set(collisionKey, artifactPath);
    return artifact;
  }
}

export function bytesArtifact(pathname: string, content: string | Uint8Array, mode?: ArtifactMode): ArtifactInput {
  const value = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const artifact: ArtifactInput = { path: pathname, source: { type: 'bytes', value } };
  if (mode !== undefined)
    artifact.mode = mode;
  return artifact;
}
