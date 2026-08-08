import { ArtifactRegistry, type ArtifactSourcePolicies } from './artifacts.js';
import { normalizeOutputPath } from './output-paths.js';
import type { DeliveryUnit, DeliveryUnitInput, PlatformId } from './contracts.js';
import type { Artifact } from './types.js';

/** DeliveryUnit ID 使用的小写 kebab-case 规则。 */
const DELIVERY_UNIT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 管理一次构建中所有 Platform 主单元与 Distribution 的全局唯一性。 */
export class DeliveryUnitRegistry {
  /** 文件型 Artifact 按 Platform、Extension 与 Public owner 隔离的来源授权。 */
  readonly #sourcePolicies: ArtifactSourcePolicies;
  /** 以 `(platform, unit-id)` 稳定键索引的不可变单元。 */
  readonly #units = new Map<string, DeliveryUnit>();

  /**
   * 创建全局 DeliveryUnit Registry。
   *
   * @param sourcePolicies 所有单元共同使用但按 owner 隔离的 Artifact 来源授权。
   */
  constructor(sourcePolicies: ArtifactSourcePolicies) {
    this.#sourcePolicies = sourcePolicies;
  }

  /**
   * 生成不会因连字符或其他字符产生歧义的单元唯一键。
   *
   * @param platform Platform ID。
   * @param id Platform 内 DeliveryUnit ID。
   * @returns JSON tuple 形式的稳定键。
   */
  #key(platform: PlatformId, id: string): string {
    return JSON.stringify([platform, id]);
  }

  /**
   * 校验、物化元数据并加入一个交付单元。
   *
   * @param platform 创建该单元的品牌化 Platform ID。
   * @param input Platform 返回的单元输入。
   * @param inheritedArtifacts Draft 中已经确定 owner 的 Public/Extension Artifact。
   * @returns owner、hash、size 与 mode 完整的不可变 DeliveryUnit。
   */
  async add(
    platform: PlatformId,
    input: DeliveryUnitInput,
    inheritedArtifacts: readonly Artifact[] = [],
  ): Promise<DeliveryUnit> {
    if (!DELIVERY_UNIT_ID_PATTERN.test(input.id))
      throw new Error(`DeliveryUnit id "${input.id}" must use lowercase kebab-case.`);
    if (input.role === 'primary' && input.type === 'marketplace')
      throw new Error('A primary DeliveryUnit cannot use marketplace type.');
    if (input.role === 'distribution' && input.type !== 'marketplace')
      throw new Error('A distribution DeliveryUnit must use marketplace type.');
    /** 当前 Platform 内单元的全局唯一键。 */
    const key = this.#key(platform, input.id);
    if (this.#units.has(key))
      throw new Error(`Duplicate DeliveryUnit "${platform}/${input.id}".`);
    /** 单元内独占的 Artifact Registry，路径不会跨单元误判冲突。 */
    const artifacts = new ArtifactRegistry(this.#sourcePolicies);
    /** Platform 是最终序列化产物的固定 owner。 */
    const owner = `platform:${platform}`;
    /** Draft 既有 Artifact 的规范路径到原始 owner 映射。 */
    const inheritedByPath = new Map(inheritedArtifacts.map(artifact => [artifact.path, artifact]));
    /**
     * Distribution 可以把已经验证的主单元整体移动到自己的子目录，因此除了目标路径，
     * 还要按 Core 冻结的 source 对象身份识别继承关系。只有调用方显式放入
     * inheritedArtifacts 的来源才能命中，Platform 不能借此取得其他 owner 的授权。
     */
    const inheritedBySource = new Map(inheritedArtifacts.map(artifact => [artifact.source, artifact]));
    for (const artifact of input.artifacts) {
      /** Platform 透传 Draft Artifact 时保留 Public 或 Extension owner。 */
      const inherited = inheritedByPath.get(normalizeOutputPath(artifact.path))
        ?? inheritedBySource.get(artifact.source);
      /** 未继承的序列化文件由 Platform 自己拥有。 */
      const artifactOwner = inherited?.owner ?? owner;
      /** 重新计算输入内容，不能信任 Platform 透传的旧 hash 字段。 */
      const added = await artifacts.add(artifactOwner, artifact);
      if (inherited && (added.size !== inherited.size || added.sha256 !== inherited.sha256 || added.mode !== inherited.mode))
        throw new Error(`Platform changed inherited Artifact "${added.path}" owned by "${inherited.owner}".`);
    }
    /** 完成单元内全部路径校验后才加入全局 Registry。 */
    const unit: DeliveryUnit = Object.freeze({
      id: input.id,
      platform,
      role: input.role,
      type: input.type,
      artifacts: artifacts.artifacts,
    });
    this.#units.set(key, unit);
    return unit;
  }

  /** @returns 按 Platform 与单元 ID 稳定排序的不可变单元快照。 */
  snapshot(): readonly DeliveryUnit[] {
    return Object.freeze([...this.#units.values()].sort((left, right) =>
      left.platform.localeCompare(right.platform, 'en')
      || left.id.localeCompare(right.id, 'en')));
  }

  /**
   * 丢弃某个 Platform 在候选验证失败前暂存的全部单元。
   *
   * @param platform 需要回滚局部生成状态的 Platform ID。
   */
  removePlatform(platform: PlatformId): void {
    for (const [key, unit] of this.#units) {
      if (unit.platform === platform)
        this.#units.delete(key);
    }
  }
}
