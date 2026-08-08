---
description: 审查并规划清理过期的 llmdoc v3 知识
requires:
  skills:
    - llmdoc
  agents:
    - reflector
---

审查 `{{arguments}}` 中可能过期、重复或与源码冲突的知识。输出保留、合并、删除候选及理由，等待人工确认；当前模板不执行删除或 rollback。
