# @tokenroll/acplugin-platform-codex

## 0.0.3-beta

### Major Changes

- 889da32: Rewrite the Codex Platform around the Package API and make `<plugin-name>-<command-id>` the sole generated Skill identity for Commands. Validate the complete Skill namespace before Asset creation, inherit Core Runtime and validated primary Assets, and remove the obsolete generated-ID strategy option.

### Patch Changes

- Updated peer dependency on `@tokenroll/acplugin` to `^0.0.2-beta`.
