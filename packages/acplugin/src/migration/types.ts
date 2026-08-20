import type { Diagnostic } from '@acplugin/core';

/** 控制旧 Claude 工程、Plugin 或 Marketplace 到规范工程的迁移。 */
export interface MigrationOptions {
  cwd?: string;
  source: string;
  destination?: string;
  subPath?: string;
  plugin?: string;
  all?: boolean;
  name?: string;
  description?: string;
  dryRun?: boolean;
  strict?: boolean;
}

/** 单项旧资源的无损迁移、降级、未映射或跳过结论。 */
export type MigrationOutcome = 'migrated' | 'degraded' | 'unmapped' | 'skipped';

/** 单个旧字段到规范字段的精确保真结论。 */
export type MigrationFieldOutcome = 'mapped' | 'degraded' | 'unmapped';

/** 迁移报告中一个字段的来源、去向和脱敏结论。 */
export interface MigrationField {
  readonly field: string;
  readonly source: string;
  readonly destination: string;
  readonly outcome: MigrationFieldOutcome;
  readonly reason: string;
}

/** 写入资源前暂存的字段结论；省略目标时才继承资源目标。 */
export type MigrationFieldDraft = Omit<MigrationField, 'destination'> & { readonly destination?: string };

/** 迁移报告中一项旧资源的处理结果与路径映射。 */
export interface MigrationItem {
  readonly kind: string;
  readonly id: string;
  readonly outcome: MigrationOutcome;
  readonly source?: string;
  readonly destination?: string;
  readonly message?: string;
  readonly fields: readonly MigrationField[];
}

/** `acplugin migrate` 返回并持久化的稳定机器可读报告。 */
export interface MigrationReport {
  readonly schemaVersion: '1';
  readonly sourceType: 'project' | 'plugin' | 'marketplace';
  readonly projects: readonly string[];
  readonly items: readonly MigrationItem[];
  readonly diagnostics: readonly Diagnostic[];
  readonly success: boolean;
  readonly dryRun: boolean;
}
