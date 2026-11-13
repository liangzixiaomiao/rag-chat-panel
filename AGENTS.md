<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md

个人知识库问答（RAG）项目。本文件是技术栈与工程约束的唯一来源。

## 技术栈（唯一允许）

- Next.js 16（App Router、TypeScript、无 src 目录、路径别名 `@/*`）
- Tailwind CSS v4 + shadcn/ui（组件落盘在 `components/ui`）
- `@supabase/supabase-js`：Postgres + pgvector，负责存储与向量检索
- `unpdf`：PDF 文本抽取；`mammoth`：DOCX 文本抽取
- `ai`：LLM 调用与流式输出
- `zod`：运行时校验
- `better-sqlite3` + `sqlite-vec`：仅方案 B 的本地向量库

## 禁止清单

1. 禁止引入未在本文件列出的库：LangChain、LlamaIndex、Prisma、Drizzle、Qdrant、Pinecone、Chroma
2. 禁止修改数据库表结构；需要变更先输出 SQL + 影响说明 + 回滚方式，等人工确认
3. 禁止在客户端组件里出现 API Key / service_role key
4. 禁止用 SDK 的 `.order('embedding')` 做向量检索
5. 禁止一次生成超过一个文件（脚手架和纯 UI 阶段除外）
6. 禁止顺手重构：不改命名、不改位置、不改我未提到的函数签名
7. 禁止吞异常

## 强制约定

1. 所有函数先写类型（入参/出参）再写实现
2. 每个错误都要：一句人话提示 + 完整 stack
3. 向量维度只在 `lib/embed.ts` 定义一次常量，其他文件不许出现 1024 / 512 字面量
4. 入库与查询必须调用同一个 embed 函数
5. chunk 必须带 `pageFrom` / `pageTo` / `headingPath` / `parentIndex` / `fullContext`
6. 每个核心函数产出后，同轮给出 3-5 条边界用例

## 目录

- `lib/`：公共库（类型、embed、检索封装）
- `lib/parse/`：文档解析（PDF / DOCX）
- `scripts/`：离线脚本（入库、切块、评测数据准备）
- `data/`：原始知识文档
- `out/`：产物输出（中间结果、导出）
- `eval/`：评测集与评测脚本
- `components/`：UI 组件，shadcn 生成物在 `components/ui`
- `app/`：App Router 根目录
- `app/api/`：路由处理器
- `app/debug/`：调试页面与调试接口
