import hooks from '@tokenroll/acplugin-extension-hooks';
import mcp from '@tokenroll/acplugin-extension-mcp';
import {
  defineConfig,
  nodeRuntimeArtifactPath,
} from '@tokenroll/acplugin';
import type { AcpluginExtension } from '@tokenroll/acplugin/sdk';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';

/**
 * 验证两个公开 Extension 与 Core Runtime 配置只依赖主包正式生态类型。
 */
export function verifyExtensionDeclarationTypes(): void {
  /** Hooks 工厂返回的品牌化公开 Extension。 */
  const hooksExtension: AcpluginExtension = hooks({ include: ['format'] });
  /** MCP 工厂返回的品牌化公开 Extension。 */
  const mcpExtension: AcpluginExtension = mcp({ include: ['docs'] });
  /** 消费者显式安装 Platform、两个 Extension 并声明 Runtime 时能够解析的最终配置。 */
  const config = defineConfig({
    name: 'extension-declaration-consumer',
    version: '1.0.0',
    description: 'Verify public Extension declarations.',
    platforms: [claudeCode()],
    runtime: { entries: { cli: { entry: './cli.ts' } } },
    extensions: [hooksExtension, mcpExtension],
  });

  /** 公开 helper 的返回类型应保留固定 Runtime 路径形状。 */
  const runtimePath: `runtime/${string}/main.mjs` = nodeRuntimeArtifactPath('cli');
  void config;
  void runtimePath;
}
