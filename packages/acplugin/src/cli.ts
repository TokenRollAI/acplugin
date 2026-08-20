#!/usr/bin/env node

import { main } from './cli/program.js';

// 仅 CLI 入口模块执行 main；库入口不会触发参数解析。
await main();
