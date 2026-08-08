# Compact continuation

完整 runtime 应在上下文压缩前保存最小续接状态，并在新上下文中校验版本和 fingerprint 后恢复任务。

当前 `PreCompact` Hook 是 no-op，不读取状态、不写续接文件，也不阻止平台压缩流程。
