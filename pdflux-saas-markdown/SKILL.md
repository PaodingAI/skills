---
name: PDFlux-PDF2Markdown
description: 将非结构化文档转化为“大模型 Ready”的结构化数据。支持 PDF、Word、PPT 及图片，一键提取段落、公式、表格、图表等元素，生成最高 8 级目录索引，并按阅读逻辑组织输出 Markdown。应用场景：字段抽取、对比校验、知识检索与智能问答。
---

# PDFlux-PDF2Markdown

执行一个 JavaScript 工作流，先通过 PDRouter 上传单个本地文件到 `pdflux` 服务，再轮询解析状态并下载 markdown。适合文档解析、表格提取、内容核对，以及把文档内容交给后续脚本继续处理。

## 安装方式

```bash
npx skills add PaodingAI/skills
```

## 运行方式

```bash
node skills/pdflux-sass-markdown/scripts/upload_to_markdown.js <local-file-path> [output-markdown-path]
```

## 执行约束

- 必须直接调用 `scripts/upload_to_markdown.js`，不要自行重写通过 PDRouter 上传、轮询、下载 markdown 的流程。
- 行为约定仅用于说明脚本做什么、输出什么、何时适合使用，不是给模型手工照着执行的步骤。
- 即使任务只是提取表格、获取字段、读取正文或为后续脚本准备输入，也必须先运行该脚本，再基于脚本产出的 markdown 继续处理。
- 只有在脚本本身不可用、报错、或需要修复脚本时，才允许检查或修改脚本实现；在正常使用场景下不要绕过脚本。

## 适用场景

- 当用户要解析文档、获取文档具体内容或抽取文档表格时，使用这个 skill。
- 当用户输入类似“转 markdown”“输出 markdown”“导出 markdown”“提取 markdown”时，使用这个 skill，并直接输出 markdown 内容。
- 当后续任务依赖文档内容继续处理，例如生成摘要、抽取字段、编写脚本处理文档、对比表格或做规则校验时，优先先用这个 skill 解析文档。
- 当只是需要文档内容供后续操作使用时，不默认向用户输出原始 markdown 全文；优先将 markdown 保存到临时文件或工作文件，再读取、筛选、提取需要的内容。
- 当用户明确要求“输出 markdown 原文”或表达的是“转 markdown”类直接转换需求时，直接展示完整 markdown。

## 环境变量

- `PD_ROUTER_API_KEY`: 必填。PDRouter 的 Bearer API Key。若未设置，脚本会直接报错；在 skill 场景下，AI 应提示用户提供可用的 key，或先将其注入环境变量后再重试。可通过 PDRouter 平台获取 API Key：[https://platform.paodingai.com/](https://platform.paodingai.com/)
- `PDFLUX_INCLUDE_IMAGES`: 可选。布尔值。等价于在 markdown 接口增加 `include_images=true`；markdown 默认不包含图片数据。

## 默认行为与可选参数

- 文件解析结果默认不包含图表、图片类解析。
- 如果业务需要图表、图片等内容，可通过接口参数显式开启；相关结果通常以 base64 形式返回，会增加额外 tokens 消耗。
- markdown 结果默认不包含图片数据；如果需要包含图片，请在 markdown 接口增加 `include_images: true` 参数，或设置 `PDFLUX_INCLUDE_IMAGES=true`。

## 脚本行为说明

1. 从 `PD_ROUTER_API_KEY` 读取令牌；若缺失则立即失败，并提示 AI 向用户索要 key 或先注入环境变量。
2. 使用 `Authorization: Bearer <token>` 调用 `POST /openapi/{serviceCode}/upload` 上传文件。
3. 持续轮询 `GET /openapi/{serviceCode}/document/{uuid}`，直到 `parsed === 2`。
4. 当解析状态为负值时立即失败。
5. 从 `GET /openapi/{serviceCode}/document/{uuid}/markdown` 下载 markdown；如有需要，可附带 markdown 查询参数，例如 `include_images=true`。
6. 若传入 `output-markdown-path`，脚本会额外将 markdown 写入该文件；同时仍会把 markdown 输出到 stdout。
7. 脚本将进度与错误写入 stderr，错误时返回非零退出码。
8. 当任务目标是获取具体内容、字段或表格时，读取解析结果并只输出必要信息，不向用户直接回显原始 markdown 全文。
9. 当用户明确表达“转 markdown”“输出 markdown”或等价意图时，直接返回 markdown 内容，而不是只返回提取后的摘要或字段。
