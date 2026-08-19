/** Playground Runtime 只输出稳定的公开健康状态。 */
process.stdout.write(`${JSON.stringify({ framework: 'acplugin', status: 'ready' })}\n`);
