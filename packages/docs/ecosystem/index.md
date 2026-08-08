# 生态开发

第三方作者使用 `@tokenroll/acplugin` 公开 SDK 创建 Platform 或 Extension，不依赖私有 Core。

- [Platform 开发](./platform-authoring.md)
- [Extension 开发](./extension-authoring.md)
- [Lifecycle 契约](./lifecycle-contract.md)
- [Artifact 与 Document](./artifacts-and-documents.md)
- [Package 与 peer 边界](./package-and-peer-boundaries.md)

ACPlugin 没有中央 registry、包名强制或自动 npm discovery。用户显式 import 并实例化品牌化对象，Core 只检查公开 API version 与 runtime brand。
