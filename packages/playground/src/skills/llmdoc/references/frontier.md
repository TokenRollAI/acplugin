# Frontier

Frontier 表示一次知识维护会话中已经调查、仍待调查和等待确认的边界。完整实现应使用稳定 ID 和输入 fingerprint 识别候选是否仍适用。

本模板不保存 Frontier，也不根据文件变化自动推进状态；Command 只能要求调用方显式列出范围和证据。
