# Dify Cloud 接入

## 启用

1. 部署代码前，使用目标数据库连接运行 `npm run db:migrate`，应用 `0014_dify_agents.sql`。本地使用 `.env.local` 时运行 `node --env-file=.env.local scripts/migrate.mjs`。
2. 在已发布的 Dify Chatbot、Chatflow 或 Agent 聊天应用中取得该应用的 API Key。
3. EduLab 管理后台 → 智能体与入口 → API 配置与连通测试 → 新增智能体。
4. 提供商选 **Dify**；API Base URL 填 `https://api.dify.ai/v1`，API Key 填应用 Key。无需 Bot ID。地址包含 `/v1`，不要填写 `/chat-messages` 端点。
5. 保存并测试后，沿用现有“创建分组入口”分配智能体、生成实验链接。

接入发送 `inputs: {}` 和学生的 `query`，因此应用需能直接响应聊天请求，不应依赖未提供的必填自定义输入。纯 Workflow 应用的 `/workflows/run`、人工审批、文件、知识库及模型管理不属于此接入。

实验入口开放或已有学生报名后，仍可在原智能体行填写新 API Key，点击“更新 Key 并测试”；提供商、API 地址、名称和启用状态继续锁定。新 Key 必须来自原 Dify 应用，应用 Key 决定调用的应用，连通测试只能验证请求是否成功，不能证明两个 Key 属于同一应用。换 Key 不重建学生会话，后续请求沿用原 `user` 和 `conversation_id`；正在生成的请求使用发出时的 Key。留空保留现有凭证，保存与审计在同一事务内执行；连接失败会分别提示“已保存”和“连接失败”，不会回显 Key。

## 会话和凭证

- `provider` 的默认值为 `coze`，旧配置和没有 provider 的旧快照仍走原 Coze SDK、轮询和恢复路径。
- Dify Key 只在服务端解密并调用 API。它复用现有 AES-256-GCM 凭证存储；历史字段名 `coze_token_*` 和 `coze_api_base_url` 保留，减少迁移范围。后台只返回 `hasToken`，不返回明文 Key；更换提供商必须重新填写 Key，Dify 不回退到 `COZE_API_TOKEN`。
- Dify 的 `user` 是实验 ID、参与者 UUID、智能体 ID、EduLab 对话 UUID 的 SHA-256 标识，不发送姓名、学号或可重复利用的 P/T 编号。即使复用相同 Dify 应用及 Key，也不会共享学生、实验、智能体或新建对话的上下文。
- `experiment_sessions.dify_conversation_id` 专门保存 Dify Conversation；Coze 的历史 Conversation、Chat、Message 字段保持原义。Dify Message / Task ID 存在请求和消息 metadata 中，供断点恢复及导出使用。
- 后续发送只读取认证后的会话快照和服务端 Conversation ID，浏览器不能指定提供商、Key、Dify user 或 Conversation ID。

## 流式与恢复

请求仍先执行原有事务：检查权限和实验限制、以 `clientRequestId` 幂等、保存用户消息、锁定本次对话。Dify 通过 `/chat-messages` 的 `response_mode: streaming` 发出请求。服务端解析 SSE，将回复逐步送到学生页面；支持 UTF-8/CRLF 分块、ping、`message`、`agent_message`、最终答案去重以及 `message_replace`。未完成的显示文本不会被当作已完成聊天记录上传。

服务端尽早提交 Conversation / Message / Task ID，收到 `message_end` 后保存完成检查点，再把最终答案、实验编号、请求轮次和消息顺序写入原记录事务。客户端断开时，Next.js `after` 保持同一次有时限的处理；单次流式调用上限为 50 秒。平台中断或数据库提交失败后，刷新可从完成检查点或 Dify `/messages` 中的**同一个 user、Conversation 和 Message ID**恢复，不重新发送问题。

Dify 普通聊天流没有可通用重开的流式端点。若请求结果无法确认，系统保留消息并提示核验，不会猜测回复或自动重发。没有 Message ID 的请求等待 2 分钟；有 ID 但无法核实的请求最多等待 15 分钟，然后标记 `uncertain`。已有会话标识始终保留，恢复不会重新分组或以空白上下文覆盖历史会话。

关闭数据库正文存储时，仅存必要的请求状态及提供商标识，不缓存问题或答案正文；当前浏览器记录和提供商历史读取仍沿用现有机制。跨设备通过实验编号恢复仍要求启用数据库正文存储。

## 跨会话历史

“开始新一次交互”建立新的 EduLab Session、Dify user 和 Conversation，但保留同一被试与原组智能体。首次请求将数据库既往完整对话及当前可见任务编码为 `query` 中的引用 JSON 背景，`inputs: {}` 不变；不要求给 Dify 应用新增变量，也不改远端系统提示词。后续请求沿用本次 Conversation，不重复注入历史。

数据库及导出中的新问题只保存学生真实输入。断流后从 Dify 返回的增强 query 取回原问题时，仅对已标记注入历史的请求解包，避免把引用历史导入新会话原始消息。Coze 使用相同背景格式与范围，各组相同规则。历史预算、来源指纹、完整性及平台窗口限制见 [多次交互与身份管理](repeat-interactions.md)；这项能力需要 `0015_repeat_interactions.sql`。

## 验证

`npm run lint`、`npm run build`；用本机 PostgreSQL 的隔离 schema 运行完整 `npm test`，共 90 项测试通过，没有跳过数据库集成测试。覆盖 Coze 历史记录、Dify 加密凭证、多轮上下文、幂等、断流、完成提交失败、未知结果、旧窗口失效、分组/实验隔离、正文存储关闭、记录导出和配置锁定。

另在真实 Next.js 生产预览、独立测试 schema 和本机模拟 Dify SSE 服务中，检查后台切换提供商、无需 Bot ID、保存并测试、Key 不回显、访问验证、分组入口和学生逐字流式显示。未使用真实 Dify Cloud Key 调用线上应用；配置真实 Key 后，可通过后台“测试连通”完成该应用的最终验证。

官方依据：[开始使用 API](https://docs.dify.ai/en/api-reference/guides/get-started)、[发送聊天消息](https://docs.dify.ai/en/api-reference/chat-messages/send-chat-message)、[SSE 与恢复](https://docs.dify.ai/en/api-reference/guides/streaming)、[会话消息历史](https://docs.dify.ai/en/api-reference/conversations/list-conversation-messages)。
