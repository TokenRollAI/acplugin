/** 报告安全边界使用的凭据字段和值保守单行匹配。 */
const CREDENTIAL = /\b(?:Bearer|Basic)\s+[^\s,;]+|\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/giu;

/** acplugin 受管临时目录的稳定匹配。 */
const TEMPORARY_PATH = /\.acplugin-(?:work|stage|backup|transaction|lock)-[^\s/\\]+/giu;

/** POSIX/Win32 绝对路径匹配，不破坏普通 package-relative path。 */
const ABSOLUTE_PATH = /(?<![A-Za-z0-9@._-])(?:[A-Za-z]:[\\/]|\/)(?:[^\s"'`:,]|:(?!\/\/))+/gu;

/**
 * 清理报告自由文本中的凭据、临时目录、绝对路径和控制空白。
 *
 * @param value Integration 或底层错误提供的原始文本。
 * @returns 不读取环境变量且可稳定序列化的单行文本。
 */
export function sanitizeStableText(value: string): string {
  return value
    .replace(CREDENTIAL, '<redacted-credential>')
    .replace(TEMPORARY_PATH, '<redacted-temp>')
    .replace(ABSOLUTE_PATH, '<path>')
    .replace(/[\0\r\n\t]+/gu, ' ')
    .trim();
}
