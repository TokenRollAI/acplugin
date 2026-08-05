# @tokenroll/acplugin-module-mcp

Official optional MCP Module for `@tokenroll/acplugin`. It supports portable Streamable HTTP declarations and bundled local stdio servers.

```ts
// acplugin.config.ts
import { defineConfig } from '@tokenroll/acplugin';
import mcp from '@tokenroll/acplugin-module-mcp';

export default defineConfig({
  name: 'tools-plugin',
  version: '1.0.0',
  description: 'Portable tools.',
  modules: [mcp()],
});
```

Remote server:

```ts
// src/mcp/docs/mcp.ts
import { defineMcpServer } from '@tokenroll/acplugin-module-mcp';

export default defineMcpServer({
  transport: 'http',
  url: 'https://example.com/mcp',
  auth: { type: 'bearer', env: 'DOCS_TOKEN' },
});
```

Local server:

```ts
// src/mcp/local-tools/mcp.ts
import { defineMcpServer } from '@tokenroll/acplugin-module-mcp';

export default defineMcpServer({
  transport: 'stdio',
  entry: 'server.ts',
});
```

acplugin bundles local Node.js servers and emits platform declarations without reading build-time secret values. Production HTTP endpoints must use HTTPS.

See the [MCP documentation](https://github.com/TokenRollAI/acplugin#mcp-module) for environment/header mappings and target output details.

## License

MIT
