import { defineHook } from '@tokenroll/acplugin-extension-hooks';

/** 把权限决策交回宿主，证明 defer 语义可被打包而不自动授权。 */
export default defineHook({
  event: 'PermissionRequest',
  /** 返回由宿主继续处理的权限决策。 */
  run() {
    return {
      decision: 'defer',
      reason: 'The host remains responsible for user authorization.',
    };
  },
});
