import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

export interface GitHubSource {
  owner: string;
  repo: string;
  branch?: string;
  subPath?: string;
}

const OWNER_PATTERN = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/;
const REPOSITORY_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

function validateSource(source: GitHubSource): GitHubSource {
  if (!OWNER_PATTERN.test(source.owner) || !REPOSITORY_PATTERN.test(source.repo))
    throw new Error('GitHub owner and repository names are invalid.');
  if (source.branch !== undefined && !isGitRef(source.branch))
    throw new Error('GitHub branch is invalid.');
  if (source.subPath !== undefined)
    resolveInside('/acplugin-source-root', source.subPath, 'GitHub sub-path');
  return source;
}

function isGitRef(value: string): boolean {
  if (value === '' || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.includes('..') || value.includes('@{') || value.includes('//'))
    return false;
  if ([...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || ' ~^:?*[\\'.includes(character)))
    return false;
  return value.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

function isInside(root: string, candidate: string): boolean {
  const relation = path.relative(root, candidate);
  return relation === '' || (!path.isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${path.sep}`));
}

function resolveInside(root: string, value: string, label: string): string {
  if (value.includes('\0') || path.isAbsolute(value))
    throw new Error(`${label} must be a relative path inside the repository.`);
  const resolved = path.resolve(root, value);
  if (!isInside(path.resolve(root), resolved))
    throw new Error(`${label} must stay inside the repository.`);
  return resolved;
}

function repositorySubPath(root: string, subPath: string | undefined): string {
  if (subPath === undefined)
    return root;
  const resolved = resolveInside(root, subPath, 'GitHub sub-path');
  if (!fs.existsSync(resolved))
    throw new Error(`GitHub sub-path "${subPath}" was not found.`);
  const realRoot = fs.realpathSync(root);
  const realResolved = fs.realpathSync(resolved);
  if (!isInside(realRoot, realResolved))
    throw new Error('GitHub sub-path resolves outside the repository.');
  return realResolved;
}

/**
 * Parse a GitHub source string into components.
 *
 * Supported formats:
 *   github:owner/repo
 *   github:owner/repo#branch
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch
 *   https://github.com/owner/repo/tree/branch/sub/path
 *   owner/repo
 *   owner/repo#branch
 */
export function parseGitHubSource(source: string): GitHubSource {
  let cleaned = source;

  // Strip github: prefix
  if (cleaned.startsWith('github:')) {
    cleaned = cleaned.slice('github:'.length);
  }

  // Handle full GitHub URLs
  const urlMatch = cleaned.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+))?)?$/,
  );
  if (urlMatch) {
    return validateSource({
      owner: urlMatch[1],
      repo: urlMatch[2],
      branch: urlMatch[3] || undefined,
      subPath: urlMatch[4] || undefined,
    });
  }

  // Handle owner/repo#branch format
  let branch: string | undefined;
  const hashIdx = cleaned.indexOf('#');
  if (hashIdx !== -1) {
    branch = cleaned.slice(hashIdx + 1);
    cleaned = cleaned.slice(0, hashIdx);
  }

  const parts = cleaned.split('/');
  if (parts.length !== 2) {
    throw new Error(
      `Invalid GitHub source: "${source}". Expected format: github:owner/repo or owner/repo`,
    );
  }

  return validateSource({
    owner: parts[0],
    repo: parts[1],
    branch,
  });
}

/**
 * Download a GitHub repo to a temp directory.
 * Prefers a shallow `git clone` without executing submodule downloads.
 * Falls back to a GitHub-generated tarball if git is unavailable.
 * Returns the path to the extracted/cloned directory.
 */
export async function downloadGitHubRepo(source: GitHubSource): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acplugin-'));
  const verified = validateSource(source);
  try {
    // Try a shallow clone first. Untrusted repository submodules are not run.
    if (isGitAvailable())
      return cloneWithGit(verified, tmpDir);

    // Fallback: GitHub-generated tarball download.
    return await downloadTarball(verified, tmpDir);
  } catch (error) {
    cleanupTempDir(tmpDir);
    throw error;
  }
}

function isGitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function cloneWithGit(source: GitHubSource, tmpDir: string): string {
  const repoUrl = `https://github.com/${source.owner}/${source.repo}.git`;
  const cloneDir = path.join(tmpDir, 'repository');

  const args = ['clone', '--depth', '1'];
  if (source.branch) {
    args.push('--branch', source.branch);
  }
  args.push('--', repoUrl, cloneDir);

  execFileSync('git', args, { stdio: 'pipe' });
  return repositorySubPath(cloneDir, source.subPath);
}

async function downloadTarball(source: GitHubSource, tmpDir: string): Promise<string> {
  const branch = source.branch || 'HEAD';
  const tarballUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/tarball/${encodeURIComponent(branch)}`;
  const tarballPath = path.join(tmpDir, 'repo.tar.gz');

  // Download tarball (follow redirects)
  await downloadFile(tarballUrl, tarballPath);

  // Extract tarball
  execFileSync('tar', ['-xzf', tarballPath, '-C', tmpDir], { stdio: 'pipe' });

  // Find the extracted directory (GitHub tarballs have a top-level dir like owner-repo-sha)
  const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  const extractedDir = entries.find(e => e.isDirectory());
  if (!extractedDir) {
    throw new Error('Failed to extract repository archive');
  }

  const repoDir = repositorySubPath(path.join(tmpDir, extractedDir.name), source.subPath);

  // Clean up tarball
  fs.unlinkSync(tarballPath);

  return repoDir;
}

/**
 * Clean up a temporary directory created by downloadGitHubRepo.
 */
export function cleanupTempDir(tmpDir: string): void {
  // Safety: only delete if it's in the system temp directory
  if (isInside(path.resolve(os.tmpdir()), path.resolve(tmpDir)) && path.resolve(tmpDir) !== path.resolve(os.tmpdir())) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Get the root temp dir from an extracted repo path (for cleanup).
 */
export function getTempRoot(repoDir: string): string {
  const tmpBase = os.tmpdir();
  const relative = path.relative(tmpBase, repoDir);
  const firstSegment = relative.split(path.sep)[0];
  return path.join(tmpBase, firstSegment);
}

function downloadFile(url: string, destPath: string, redirectCount = 0): Promise<void> {
  if (redirectCount > 5) {
    return Promise.reject(new Error('Too many redirects'));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const allowedHosts = new Set(['api.github.com', 'github.com', 'codeload.github.com']);
    if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
      reject(new Error('GitHub download redirect was rejected.'));
      return;
    }
    const req = https.get(parsed, {
      headers: {
        'User-Agent': 'acplugin/1.0',
        'Accept': 'application/vnd.github+json',
        ...(parsed.hostname === 'api.github.com' && process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(downloadFile(res.headers.location, destPath, redirectCount + 1));
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`GitHub API returned ${res.statusCode}. Check that the repository exists and is accessible.`));
        return;
      }

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      fileStream.on('error', reject);
    });
    req.on('error', reject);
  });
}
