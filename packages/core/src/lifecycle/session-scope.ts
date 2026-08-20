/**
 * 绑定一次 BuildSession 内所有 capability registry 的存活状态。
 *
 * Scope 本身不通过 SDK 暴露；SourceRef/AssetRef 的运行时授权仍由各 Registry
 * 的 WeakMap 对象身份记录完成。
 */
export class BuildSessionScope {
  /** 当前 Session 是否仍允许使用已签发能力。 */
  #active = true;

  /** 当前 Scope 独占且不可从公开 ref 恢复的身份 token。 */
  readonly token: Readonly<Record<string, never>> = Object.freeze({});

  /**
   * 确认当前 BuildSession 仍处于活动状态。
   *
   * @throws Session 已关闭时抛出稳定错误。
   */
  assertActive(): void {
    if (!this.#active)
      throw new Error('BuildSession capabilities are no longer active.');
  }

  /** 使本 Session 已签发的全部能力立即失效。 */
  close(): void {
    this.#active = false;
  }
}
