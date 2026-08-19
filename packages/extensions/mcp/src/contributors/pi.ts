import type { ContributionContext, PlatformContributor } from '@tokenroll/acplugin/sdk';
import type { BuiltMcpServers } from '../build.js';
import { collector, finishContribution, reportTransport } from './common.js';

/** Pi Contributor 明确报告 MCP 不可交付且不生成伪配置。 */
export const piContributor: PlatformContributor<BuiltMcpServers> = Object.freeze({
  platform: 'pi',
  platformApiVersion: '1',
  /** 为每个 Server 报告真实 unsupported transport。 */
  contribute(_context: ContributionContext, built: Readonly<BuiltMcpServers>) {
    /** output 只包含 compatibility，不产生 Asset 或 Document 字段。 */
    const output = collector();
    for (const server of built.servers) {
      reportTransport(
        output,
        server,
        'unsupported',
        'Pi has no verified MCP installation contract for this transport.',
      );
    }
    return finishContribution(output);
  },
});
