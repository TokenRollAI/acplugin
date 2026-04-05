import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

export interface GitHubSource {
  owner: string;
  repo: string;
  branch?: string;
  subPath?: string;
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
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+))?)?$/
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      branch: urlMatch[3] || undefined,
      subPath: urlMatch[4] || undefined,
    };
  }

  // Handle owner/repo#branch format
  let branch: string | undefined;
  const hashIdx = cleaned.indexOf('#');
  if (hashIdx !== -1) {
    branch = cleaned.slice(hashIdx + 1);
    cleaned = cleaned.slice(0, hashIdx);
  }

  const parts = cleaned.split('/');
  if (parts.length < 2) {
    throw new Error(
      `Invalid GitHub source: "${source}". Expected format: github:owner/repo or owner/repo`
    );
  }

  return {
    owner: parts[0],
    repo: parts[1],
    branch,
  };
}

/**
 * Download a GitHub repo to a temp directory.
 * Prefers `git clone --recurse-submodules` (handles submodules properly).
 * Falls back to tarball download if git is unavailable.
 * Returns the path to the extracted/cloned directory.
 */
export async function downloadGitHubRepo(source: GitHubSource): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acplugin-'));

  // Try git clone first (supports submodules)
  if (isGitAvailable()) {
    return cloneWithGit(source, tmpDir);
  }

  // Fallback: tarball download (no submodule support)
  return downloadTarball(source, tmpDir);
}

function isGitAvailable(): boolean {
  try {
    execSync('git --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function cloneWithGit(source: GitHubSource, tmpDir: string): string {
  const repoUrl = `https://github.com/${source.owner}/${source.repo}.git`;
  const cloneDir = path.join(tmpDir, source.repo);

  const args = ['clone', '--depth', '1', '--recurse-submodules', '--shallow-submodules'];
  if (source.branch) {
    args.push('--branch', source.branch);
  }
  args.push(repoUrl, cloneDir);

  execSync(`git ${args.join(' ')}`, { stdio: 'pipe' });

  let repoDir = cloneDir;
  if (source.subPath) {
    const subDir = path.join(repoDir, source.subPath);
    if (!fs.existsSync(subDir)) {
      throw new Error(`Sub-path "${source.subPath}" not found in repository`);
    }
    repoDir = subDir;
  }

  return repoDir;
}

async function downloadTarball(source: GitHubSource, tmpDir: string): Promise<string> {
  const branch = source.branch || 'HEAD';
  const tarballUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/tarball/${branch}`;
  const tarballPath = path.join(tmpDir, 'repo.tar.gz');

  // Download tarball (follow redirects)
  await downloadFile(tarballUrl, tarballPath);

  // Extract tarball
  execSync(`tar -xzf "${tarballPath}" -C "${tmpDir}"`, { stdio: 'pipe' });

  // Find the extracted directory (GitHub tarballs have a top-level dir like owner-repo-sha)
  const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  const extractedDir = entries.find(e => e.isDirectory());
  if (!extractedDir) {
    throw new Error('Failed to extract repository archive');
  }

  let repoDir = path.join(tmpDir, extractedDir.name);

  // If subPath specified, point to that subdirectory
  if (source.subPath) {
    const subDir = path.join(repoDir, source.subPath);
    if (!fs.existsSync(subDir)) {
      throw new Error(`Sub-path "${source.subPath}" not found in repository`);
    }
    repoDir = subDir;
  }

  // Clean up tarball
  fs.unlinkSync(tarballPath);

  return repoDir;
}

/**
 * Clean up a temporary directory created by downloadGitHubRepo.
 */
export function cleanupTempDir(tmpDir: string): void {
  // Safety: only delete if it's in the system temp directory
  if (tmpDir.startsWith(os.tmpdir())) {
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
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'acplugin/1.0',
        'Accept': 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
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
