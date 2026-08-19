import {
  createKernelProject,
  ProjectConfigError,
  runKernelProject,
} from '@acplugin/core';
import type {
  BuildReport,
  CreateProjectOptions,
  Project,
  RunProjectOptions,
} from '@acplugin/core/kernel-author';
import { ACPLUGIN_VERSION } from './version.js';

export { ProjectConfigError };

/** 创建绑定同一工程身份且只执行 Kernel BuildSession 的 Project。 */
export function createProject(options: CreateProjectOptions = {}): Project {
  return createKernelProject(options, ACPLUGIN_VERSION);
}

/** createProject(...).run(...) 的无逻辑 convenience。 */
export function runProject(options: RunProjectOptions = {}): Promise<BuildReport> {
  return runKernelProject(options, ACPLUGIN_VERSION);
}
