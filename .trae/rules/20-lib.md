---
alwaysApply: false
globs: 
---
# 工具层规则（lib/**/*.ts）

- 纯函数优先：parse / chunk 不许有 IO、不许有网络、不许读环境变量
- lib 层不许 import React、不许写 JSX
- 错误向上抛，不在 lib 层吞异常或做兜底话术
- 向量维度 / 模型名只在 lib/embed.ts 定义一次，禁止出现第二份 token 估算
- 入库和查询必须复用同一个 embedTexts，不许另写实现
- 不做任何“清洗”（去重、去空白、改标点），原文必须逐字保留
- 不确定的 API 方法名，停下来问，不要发明不存在的方法