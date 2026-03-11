---
name: pdflux-saas-markdown
description: 解析文档并获取文档内容，尤其适用于提取 PDF、DOCX、DOC、PPT、PPTX、PNG、JPG、JPEG 等文件中的正文与表格内容。用于将文件转换为 markdown、响应“转 markdown”这类需求、读取文档具体内容、基于文档内容执行后续分析或脚本处理；当需要编写脚本解析文档时，优先使用这个 skill。
---

# pdflux-saas-markdown

执行一个 JavaScript 工作流，先把单个本地文件解析为 markdown，再基于 markdown 获取正文、表格和结构化内容。支持 PDF、Word、PPT 和图片等常见格式，适合文档解析、表格提取、内容核对，以及把文档内容交给后续脚本继续处理。

## 运行方式

```bash
node .claude/skills/pdflux-saas-markdown/scripts/upload_to_markdown.js <local-file-path>
```

## 执行约束

- 必须直接调用 `scripts/upload_to_markdown.js` 执行，不要根据下方行为约定自行重写上传、轮询、下载 markdown 的流程。
- 行为约定仅用于说明脚本做什么、输出什么、何时适合使用，不是给模型手工照着执行的步骤。
- 即使任务只是提取表格、获取字段、读取正文或为后续脚本准备输入，也必须先运行该脚本，再基于脚本产出的 markdown 继续处理。
- 只有在脚本本身不可用、报错、或需要修复脚本时，才允许检查或修改脚本实现；在正常使用场景下不要绕过脚本。

## 适用场景

- 当用户要解析文档、获取文档具体内容或抽取文档表格时，使用这个 skill。
- 当用户输入类似“转 markdown”“输出 markdown”“导出 markdown”“提取 markdown”时，使用这个 skill，并直接输出 markdown 内容。
- 当后续任务依赖文档内容继续处理，例如生成摘要、抽取字段、编写脚本处理文档、对比表格或做规则校验时，优先先用这个 skill 解析文档。
- 当只是需要文档内容供后续操作使用时，不默认向用户输出原始 markdown 全文；优先将 markdown 保存到临时文件，再读取、筛选、提取需要的内容。
- 当用户明确要求“输出 markdown 原文”或表达的是“转 markdown”类直接转换需求时，直接展示完整 markdown。

## 环境变量

- `PAODINGAI_API_KEY`: 必填访问令牌。若未设置，提示 `Enter PAODINGAI_API_KEY:` 并接收手动输入。
- `PAODINGAI_API_BASE_URL`: 可选 API 域名。默认值：`https://saas.pdflux.com`。

## 脚本行为说明

1. 优先从 `PAODINGAI_API_KEY` 读取令牌，缺失时回退到交互式输入。
2. 使用 `Authorization: Bearer <token>` 调用 `/api/v1/saas/upload` 上传文件。
3. 持续轮询 `/api/v1/saas/document/{uuid}`，直到 `parsed === 2`。
4. 当解析状态为负值时立即失败。
5. 从 `/api/v1/saas/document/{uuid}/markdown` 下载 markdown。
6. 脚本默认将 markdown 内容写入 stdout，因此在实际使用中，若后续还要继续消费文档内容，优先将 stdout 重定向到临时文件或工作文件，再读取文件内容进行后续处理。
7. 当任务目标是获取具体内容、字段或表格时，读取解析结果并只输出必要信息，不向用户直接回显原始 markdown 全文。
8. 当用户明确表达“转 markdown”“输出 markdown”或等价意图时，直接返回 markdown 内容，而不是只返回提取后的摘要或字段。
9. 将进度与错误写入 stderr，错误时返回非零退出码。
