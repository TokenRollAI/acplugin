/** JSON-RPC 请求 ID 的可移植表示。 */
type RequestId = string | number | null;

/** Playground MCP 只读取 smoke 和演示调用所需的请求字段。 */
interface JsonRpcRequest {
  readonly id?: RequestId;
  readonly method?: string;
  readonly params?: unknown;
}

/** 向 stdout 写入一行确定性的 JSON-RPC 消息。 */
function respond(id: RequestId, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

/** 向 stdout 写入不包含输入或环境值的稳定 JSON-RPC 错误。 */
function reject(id: RequestId, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

/** 判断未知值是否为可安全索引的普通对象。 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 处理一条完整 JSON-RPC 请求；通知不产生响应。 */
function handle(request: JsonRpcRequest): void {
  if (request.method === 'notifications/initialized')
    return;
  if (request.id === undefined)
    return;
  if (request.method === 'initialize') {
    /** 客户端请求的协议版本；缺失时使用模板固定版本。 */
    const protocolVersion = isRecord(request.params) && typeof request.params.protocolVersion === 'string'
      ? request.params.protocolVersion
      : '2025-11-25';
    respond(request.id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'acplugin-playground', version: '0.1.0' },
    });
    return;
  }
  if (request.method === 'tools/list') {
    respond(request.id, {
      tools: [{
        name: 'inspect-template',
        description: 'Describe the static ACPlugin playground boundary.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      }],
    });
    return;
  }
  if (request.method === 'tools/call') {
    /** tools/call 的工具名必须来自 params.name。 */
    const name = isRecord(request.params) ? request.params.name : undefined;
    if (name !== 'inspect-template') {
      reject(request.id, -32_602, 'Unknown playground tool.');
      return;
    }
    respond(request.id, {
      content: [{
        type: 'text',
        text: 'This is a static ACPlugin capability template; product-specific behavior is intentionally absent.',
      }],
      isError: false,
    });
    return;
  }
  reject(request.id, -32_601, 'Method not found.');
}

/** 当前尚未形成完整换行分帧的 stdin 文本。 */
let inputBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  inputBuffer += chunk;
  /** 本次数据后形成的完整行与末尾半行。 */
  const lines = inputBuffer.split('\n');
  inputBuffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '')
      continue;
    /** JSON.parse 结果只读取 JsonRpcRequest 的受控字段。 */
    const request = JSON.parse(line) as JsonRpcRequest;
    handle(request);
  }
});
