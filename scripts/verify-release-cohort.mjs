import { readFileSync } from 'node:fs';
import process from 'node:process';

const publicPackages = [
  ['packages/module-hooks/package.json', '@tokenroll/acplugin-module-hooks'],
  ['packages/module-mcp/package.json', '@tokenroll/acplugin-module-mcp'],
  ['packages/acplugin/package.json', '@tokenroll/acplugin'],
];

const manifests = publicPackages.map(([file, expectedName]) => {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.name !== expectedName)
    throw new Error(`${file} has unexpected package name ${manifest.name}.`);
  if (manifest.private === true)
    throw new Error(`${expectedName} must remain publishable.`);
  return manifest;
});

const versions = new Set(manifests.map(manifest => manifest.version));
if (versions.size !== 1)
  throw new Error('Public package versions are not fixed.');

const version = manifests[0].version;
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag && tag !== `tokenroll-v${version}`)
  throw new Error(`Tag ${tag} must equal tokenroll-v${version}.`);

for (const moduleManifest of manifests.slice(0, 2)) {
  if (moduleManifest.peerDependencies?.['@tokenroll/acplugin'] !== 'workspace:^')
    throw new Error(`${moduleManifest.name} must use workspace:^ for its acplugin peer.`);
}

process.stdout.write(`Verified fixed @tokenroll/acplugin ${version} release cohort${tag ? ` for ${tag}` : ''}.\n`);
