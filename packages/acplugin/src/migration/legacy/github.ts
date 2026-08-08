import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

/** 完成解析和校验的 GitHub 仓库来源。 */
export interface GitHubSource {
  /** GitHub 组织或用户名称。 */
  owner: string;
  /** 仓库名称，不含 `.git`。 */
  repo: string;
  /** 可选的分支、Tag 或其他安全 Git Ref。 */
  branch?: string;
  /** 可选的仓库内部相对目录。 */
  subPath?: string;
}

/** GitHub Owner 名称接受的格式和长度。 */
const OWNER_PATTERN = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/;
/** GitHub Repository 名称接受的保守格式和长度。 */
const REPOSITORY_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/**
 * 校验 GitHub 来源字段，避免参数注入和仓库子路径逃逸。
 *
 * @param source 待验证来源。
 * @returns 同一个已验证来源对象。
 */
function validateSource(source: GitHubSource): GitHubSource {
  if (!OWNER_PATTERN.test(source.owner) || !REPOSITORY_PATTERN.test(source.repo))
    throw new Error('GitHub owner and repository names are invalid.');
  if (source.branch !== undefined && !isGitRef(source.branch))
    throw new Error('GitHub branch is invalid.');
  if (source.subPath !== undefined)
    resolveInside('/acplugin-source-root', source.subPath, 'GitHub sub-path');
  return source;
}

/**
 * 按 Git ref-format 的关键安全约束验证分支或 Tag。
 *
 * @param value 待验证 Ref。
 * @returns 不包含控制字符、选项前缀和危险序列时返回 true。
 */
function isGitRef(value: string): boolean {
  if (value === '' || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.includes('..') || value.includes('@{') || value.includes('//'))
    return false;
  if ([...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || ' ~^:?*[\\'.includes(character)))
    return false;
  return value.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * 判断候选路径是否位于指定根目录内。
 *
 * @param root 可信根目录。
 * @param candidate 待验证路径。
 * @returns 候选路径未逃逸时返回 true。
 */
function isInside(root: string, candidate: string): boolean {
  /** 基于真实路径层级而非字符串前缀的相对关系。 */
  const relation = path.relative(root, candidate);
  return relation === '' || (!path.isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${path.sep}`));
}

/**
 * 在可信根目录内解析用户相对路径。
 *
 * @param root 可信根目录。
 * @param value 用户提供的相对路径。
 * @param label 错误消息使用的字段名称。
 * @returns 未逃逸根目录的绝对路径。
 */
function resolveInside(root: string, value: string, label: string): string {
  if (value.includes('\0') || path.isAbsolute(value))
    throw new Error(`${label} must be a relative path inside the repository.`);
  /** 解析后的候选绝对路径。 */
  const resolved = path.resolve(root, value);
  if (!isInside(path.resolve(root), resolved))
    throw new Error(`${label} must stay inside the repository.`);
  return resolved;
}

/**
 * 解析并验证下载仓库内的可选子路径，包括符号链接后的真实路径。
 *
 * @param root 下载或解压后的仓库根目录。
 * @param subPath 可选的仓库内部目录。
 * @returns 存在且真实路径仍位于仓库内的目录。
 */
function repositorySubPath(root: string, subPath: string | undefined): string {
  if (subPath === undefined)
    return root;
  /** 尚未解析符号链接的仓库内候选路径。 */
  const resolved = resolveInside(root, subPath, 'GitHub sub-path');
  if (!fs.existsSync(resolved))
    throw new Error(`GitHub sub-path "${subPath}" was not found.`);
  /** 仓库根目录解析符号链接后的真实路径。 */
  const realRoot = fs.realpathSync(root);
  /** 子路径解析符号链接后的真实路径。 */
  const realResolved = fs.realpathSync(resolved);
  if (!isInside(realRoot, realResolved))
    throw new Error('GitHub sub-path resolves outside the repository.');
  return realResolved;
}

/**
 * 把受支持的 GitHub 来源字符串解析为结构化字段。
 *
 * 支持 `github:owner/repo[#ref]`、GitHub URL 与 `owner/repo[#ref]` 简写。
 *   github:owner/repo
 *   github:owner/repo#branch
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch
 *   https://github.com/owner/repo/tree/branch/sub/path
 *   owner/repo
 *   owner/repo#branch
 *
 * @param source 用户提供的 GitHub 来源。
 * @returns 完成字段和路径校验的来源对象。
 */
export function parseGitHubSource(source: string): GitHubSource {
  /** 移除可选协议前缀后参与语法解析的文本。 */
  let cleaned = source;

  // 移除便于 CLI 区分本地路径的 github: 前缀。
  if (cleaned.startsWith('github:')) {
    cleaned = cleaned.slice('github:'.length);
  }

  // 完整 GitHub URL 可同时编码 Ref 和仓库子路径。
  /** 完整 GitHub URL 的字段捕获结果。 */
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

  // owner/repo 简写使用井号携带可选 Ref。
  /** 简写中提取的可选 Git Ref。 */
  let branch: string | undefined;
  /** 简写中井号分隔符的位置。 */
  const hashIdx = cleaned.indexOf('#');
  if (hashIdx !== -1) {
    branch = cleaned.slice(hashIdx + 1);
    cleaned = cleaned.slice(0, hashIdx);
  }

  /** owner/repo 简写的两个路径片段。 */
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
 * 把 GitHub 仓库下载到系统临时目录。
 *
 * 优先执行不下载子模块的浅克隆；Git 不可用时回退到 GitHub 生成的 tarball。
 *
 * @param source 已解析或待再次验证的 GitHub 来源。
 * @returns 克隆/解压后的仓库根目录或安全子路径。
 */
export async function downloadGitHubRepo(source: GitHubSource): Promise<string> {
  /** 当前下载独占、失败时完整清理的系统临时目录。 */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acplugin-'));
  /** 在产生任何网络或进程副作用前重新校验的来源。 */
  const verified = validateSource(source);
  try {
    // 浅克隆不会初始化不受信任仓库声明的 submodule。
    if (isGitAvailable())
      return cloneWithGit(verified, tmpDir);

    // Git 不可用时下载 GitHub 生成的归档。
    return await downloadTarball(verified, tmpDir);
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
    cleanupTempDir(tmpDir);
    throw error;
  }
}

/**
 * 判断当前环境是否可执行 Git。
 *
 * @returns `git --version` 成功时返回 true。
 */
function isGitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 使用参数数组执行安全浅克隆，不通过 Shell 拼接不受信任字段。
 *
 * @param source 已验证 GitHub 来源。
 * @param tmpDir 当前下载临时目录。
 * @returns 仓库根目录或验证后的子路径。
 */
function cloneWithGit(source: GitHubSource, tmpDir: string): string {
  /** 由已验证 owner/repo 构造的 HTTPS Clone URL。 */
  const repoUrl = `https://github.com/${source.owner}/${source.repo}.git`;
  /** 临时目录内固定的克隆目标。 */
  const cloneDir = path.join(tmpDir, 'repository');

  /** 传给 execFileSync 的独立 Git 参数，`--` 终止选项解析。 */
  const args = ['clone', '--depth', '1'];
  if (source.branch) {
    args.push('--branch', source.branch);
  }
  args.push('--', repoUrl, cloneDir);

  execFileSync('git', args, { stdio: 'pipe' });
  return repositorySubPath(cloneDir, source.subPath);
}

/**
 * 下载并解压 GitHub 生成的仓库 tarball。
 *
 * @param source 已验证 GitHub 来源。
 * @param tmpDir 当前下载临时目录。
 * @returns 解压仓库根目录或验证后的子路径。
 */
async function downloadTarball(source: GitHubSource, tmpDir: string): Promise<string> {
  /** 未指定 Ref 时由 GitHub 解析默认分支的归档标识。 */
  const branch = source.branch || 'HEAD';
  /** 仅指向 GitHub API 允许主机的归档 URL。 */
  const tarballUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/tarball/${encodeURIComponent(branch)}`;
  /** 临时目录内固定的归档文件路径。 */
  const tarballPath = path.join(tmpDir, 'repo.tar.gz');

  // 下载函数会限制重定向次数和允许的 GitHub 主机。
  await downloadFile(tarballUrl, tarballPath);

  // 使用参数数组调用系统 tar，不执行 Shell。
  execFileSync('tar', ['-xzf', tarballPath, '-C', tmpDir], { stdio: 'pipe' });

  // GitHub 归档始终带 owner-repo-sha 形式的顶层目录。
  /** 解压后临时目录的一级内容。 */
  const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  /** GitHub 归档创建的顶层仓库目录。 */
  const extractedDir = entries.find(e => e.isDirectory());
  if (!extractedDir) {
    throw new Error('Failed to extract repository archive');
  }

  /** 完成真实路径边界检查的仓库目录或子路径。 */
  const repoDir = repositorySubPath(path.join(tmpDir, extractedDir.name), source.subPath);

  // 解压成功后删除原始归档，最终清理只需处理目录树。
  fs.unlinkSync(tarballPath);

  return repoDir;
}

/**
 * 清理由 downloadGitHubRepo 创建的临时目录。
 *
 * @param tmpDir 待删除临时根目录。
 */
export function cleanupTempDir(tmpDir: string): void {
  // 只允许删除系统临时目录内的后代，绝不删除临时目录本身。
  if (isInside(path.resolve(os.tmpdir()), path.resolve(tmpDir)) && path.resolve(tmpDir) !== path.resolve(os.tmpdir())) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 从下载仓库或子路径反推出本次下载的临时根目录。
 *
 * @param repoDir downloadGitHubRepo 返回的仓库路径。
 * @returns 系统临时目录下的第一级下载目录。
 */
export function getTempRoot(repoDir: string): string {
  /** 当前系统临时目录。 */
  const tmpBase = os.tmpdir();
  /** 仓库路径相对于系统临时目录的位置。 */
  const relative = path.relative(tmpBase, repoDir);
  /** 属于本次下载的第一级临时目录名称。 */
  const firstSegment = relative.split(path.sep)[0];
  return path.join(tmpBase, firstSegment);
}

/**
 * 通过 HTTPS 下载文件，并只跟随 GitHub 官方主机间的有限次重定向。
 *
 * @param url 当前下载或重定向 URL。
 * @param destPath 归档写入路径。
 * @param redirectCount 已跟随的重定向次数。
 * @returns 文件流完成写入时兑现的 Promise。
 */
function downloadFile(url: string, destPath: string, redirectCount = 0): Promise<void> {
  if (redirectCount > 5) {
    return Promise.reject(new Error('Too many redirects'));
  }

  return new Promise((resolve, reject) => {
    /** 完成协议和主机验证的当前请求 URL。 */
    const parsed = new URL(url);
    /** GitHub API 归档下载允许跳转的官方主机集合。 */
    const allowedHosts = new Set(['api.github.com', 'github.com', 'codeload.github.com']);
    if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
      reject(new Error('GitHub download redirect was rejected.'));
      return;
    }
    /** 当前 HTTPS 下载请求；错误统一传递给 Promise。 */
    const req = https.get(parsed, {
      headers: {
        'User-Agent': 'acplugin/1.0',
        'Accept': 'application/vnd.github+json',
        ...(parsed.hostname === 'api.github.com' && process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    }, (res) => {
      // 只通过递归入口继续重定向，以重复执行协议、主机和次数校验。
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(downloadFile(res.headers.location, destPath, redirectCount + 1));
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`GitHub API returned ${res.statusCode}. Check that the repository exists and is accessible.`));
        return;
      }

      /** 把响应体落盘到固定归档路径的文件流。 */
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
