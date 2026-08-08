---
description: 把已确认结论整理成待提交的稳定知识草案
model: inherit
capabilities:
  - filesystem:read
  - filesystem:write
---

只根据已确认结论生成结构化草案，保留来源与适用范围。当前模板不提供 transaction；实际写入前必须由完整 runtime 再次校验目标和冲突。
