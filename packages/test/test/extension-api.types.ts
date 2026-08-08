import hooks from '@tokenroll/acplugin-extension-hooks';
import mcp from '@tokenroll/acplugin-extension-mcp';
import {
  defineConfig,
  type AcpluginExtension,
} from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';

/**
 * 验证两个公开 Extension 的声明只依赖主包正式生态类型。
 */
export function verifyExtensionDeclarationTypes(): void {
  /** Hooks 工厂返回的品牌化公开 Extension。 */
  const hooksExtension: AcpluginExtension = hooks({ include: ['format'] });
  /** MCP 工厂返回的品牌化公开 Extension。 */
  const mcpExtension: AcpluginExtension = mcp({ include: ['docs'] });
  /** 消费者显式安装 Platform 和两个 Extension 时能够解析的最终配置。 */
  const config = defineConfig({
    name: 'extension-declaration-consumer',
    version: '1.0.0',
    description: 'Verify public Extension declarations.',
    platforms: [claudeCode()],
    extensions: [hooksExtension, mcpExtension],
  });

  void config;
}
