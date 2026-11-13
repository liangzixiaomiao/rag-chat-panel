---
alwaysApply: false
globs: 
---
# 接口层规则（app/api/**/*.ts）

- 所有入参必须用 zod 校验，校验失败返回 400 + 人话提示
- 所有 handler 必须 try/catch，错误不许裸抛给客户端
- 客户端只收到 { error: '人话提示' }，完整 stack 只打服务端日志
- 禁止把整本文档塞进一次请求；长任务必须分批（cursor 参数），单批不超过 100 个子块
- documentId 缺失返回 400，禁止 fallback 成全库
- 禁止返回 embedding 字段
- 流式接口出错时保留已发内容，末尾补 error 事件，不许静默断流
- 检索用改写后的 query，生成用原问题，两者不许混用