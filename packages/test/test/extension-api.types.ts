import hooks from '@tokenroll/acplugin-extension-hooks';
import mcp from '@tokenroll/acplugin-extension-mcp';
import {
  defineConfig,
  type AcpluginExtension,
} from '@tokenroll/acplugin';

/**
 * 验证两个公开 Extension 的声明只依赖主包正式生态类型。
 */
export function verifyExtensionDeclarationTypes(): void {
  /** Hooks 工厂返回的品牌化公开 Extension。 */
  const hooksExtension: AcpluginExtension = hooks({ include: ['format'] });
  /** MCP 工厂返回的品牌化公开 Extension。 */
  const mcpExtension: AcpluginExtension = mcp({ include: ['docs'] });
  /** 消费者只安装三个公开包时能够解析的最终配置。 */
  const config = defineConfig({
    name: 'extension-declaration-consumer',
    version: '1.0.0',
    description: 'Verify public Extension declarations.',
    extensions: [hooksExtension, mcpExtension],
  });

  void config;
}
