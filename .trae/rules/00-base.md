# 基础规则（始终生效）

## 禁止清单
- 禁止引入未在 AGENTS.md 技术栈列出的库：LangChain、LlamaIndex、Prisma、Drizzle、Qdrant、Pinecone、Chroma
- 禁止修改数据库表结构；需要变更必须先输出 SQL + 影响说明 + 回滚方式，等人工确认
- 禁止在客户端组件里出现 API Key / service_role key / 任何 sk- 开头字符串
- 禁止用 SDK 的 .order('embedding') 做向量检索
- 禁止一次生成超过一个文件（脚手架和纯 UI 阶段除外）
- 禁止顺手重构：不改命名、不改位置、不改我未提到的函数签名
- 禁止吞异常
- 禁止使用 any（catch 块也不许 catch (e: any)）

## 强制约定
- 所有函数先写类型（入参/出参）再写实现
- 每个错误都要：一句人话提示 + 完整 stack
- 向量维度只在 lib/embed.ts 定义一次常量，其他文件不许出现 1024 / 512 字面量
- 入库与查询必须调用同一个 embed 函数
- chunk 必须带 pageFrom / pageTo / headingPath / parentIndex / fullContext
- 每个核心函数产出后，同轮给出 3-5 条边界用例
- 不确定 API 方法名时停下来问，禁止发明不存在的方法