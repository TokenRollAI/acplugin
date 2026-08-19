# Domain glossary

> [中文对照](domain-glossary.zh-CN.md)

| Term | Meaning |
| --- | --- |
| Author facade | The root `@tokenroll/acplugin` API used by project configuration, Project execution, reports, init, and Migration. |
| Integration SDK | The trusted `@tokenroll/acplugin/sdk` subpath used only to implement Platforms and Extensions. |
| Canonical Project | The immutable Commands, Skills, Agents, Public files, optional Runtime, metadata, and validated dependency graph discovered by Core. |
| Session | Per-build mutable implementation state created by a Platform or Extension factory and closed exactly once by Core. |
| SourceRef | An owner-scoped reference to an exact validated author file or directory; it is not a physical path capability. |
| AssetRef | A current-session Source, Generated, or Bytes output reference signed by Core. |
| Asset | A Package path mapped to an AssetRef. Reports add owner, mode, size, SHA-256, and structured origin. |
| Document | A Platform-owned structured JSON, YAML, TOML, or frontmatter value serialized by the Core codec. |
| Extension point | An exact empty Document field path that the Platform explicitly allows one Contribution to fill. |
| Base Package | The immutable Documents, Assets, compatibility, and metadata dispositions returned by `Platform.createPackage()`. |
| Platform Contributor | An Extension callback that reads the same base Package and returns one independent add-only Package Contribution. |
| Package Contribution | Optional Document fields and Assets plus required compatibility entries. It cannot replace or delete base content. |
| Merged Package | Core's deterministic result after validating and combining Framework and Extension Contributions with the base Package. |
| Primary Package | The finalized installable Plugin, workspace, or npm package, including all inherited merged Assets. |
| Distribution | An optional Package derived only after the primary Package candidate has passed Platform validation. |
| Package candidate | A Core-owned temporary materialization of the exact Package tree passed to `validatePackage()`. |
| Compatibility | A Platform/resource/capability tuple reported as `native`, `transform`, `degraded`, or `unsupported`. |
| BuildReport | The stable schema-v2 result containing Project, Package, Asset provenance, compatibility, metadata, Platform status, and diagnostics. |
| Managed output | The complete configured output root replaced transactionally for the selected Platform set. |
