import { describe, expect, it } from 'vitest';
import type { CanonicalProject, NodeRuntimeResource, PublicResourceFile } from '../../src/contracts/index.js';
import { assembleProjectGraph } from '../../src/resources/project-graph.js';

describe('Project Graph assembly', () => {
  it('preserves immutable provider identities and exposes no project root', () => {
    const canonical: CanonicalProject = Object.freeze({
      metadata: Object.freeze({ name: 'graph', version: '1.0.0', description: 'Graph.', keywords: Object.freeze([]) }),
      commands: Object.freeze([]),
      skills: Object.freeze([]),
      agents: Object.freeze([]),
      publicFiles: Object.freeze([]),
    });
    const publicFiles = Object.freeze([
      { path: 'schema.json', asset: Object.freeze({ kind: 'source-asset' }) },
    ]) as unknown as readonly PublicResourceFile[];
    const runtime = Object.freeze({
      target: 'node20',
      entries: Object.freeze([
        { id: 'cli', kind: 'executable', source: Object.freeze({ kind: 'source-file', path: 'src/runtime/cli.ts' }) },
      ]),
    }) as unknown as NodeRuntimeResource;

    const project = assembleProjectGraph(canonical, publicFiles, runtime);
    expect(project.publicFiles).toBe(publicFiles);
    expect(project.runtime).toBe(runtime);
    expect(project.commands).toBe(canonical.commands);
    expect(Object.isFrozen(project)).toBe(true);
    expect(JSON.stringify(project)).not.toContain('/Users/');
    expect('root' in project).toBe(false);
  });
});
