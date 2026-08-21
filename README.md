# EduLab

EduLab 是一个面向教育实验研究的轻量 AI 智能体交互平台。学生通过研究者提供的签名链接进入实验，阅读任务并与指定 Coze 智能体连续对话。消息正文实时保存在当前浏览器，实验结束时可一次性写入 PostgreSQL，并可导出 JSON 作为人工备份。

## 技术方案

- Next.js App Router：学生页面和仅服务端可访问的 API
- Coze 官方 `@coze/api` SDK：非流式创建 Chat、轮询状态并读取最终消息
- 标准 PostgreSQL + `pg`：Neon 可直接使用，也可迁移到任何 PostgreSQL 服务
- HttpOnly 会话 Cookie：浏览器无法读取会话密钥，修改 URL 不能读取其他参与者数据
- 请求幂等键 + 会话串行锁：防止重复点击产生重复记录
- Coze Chat/Conversation 标识先落库：刷新或请求中断后可恢复未完成回复
- 可折叠多对话侧栏：同一参与者可以创建和切换多个独立 Coze Conversation

## 本地启动

1. 复制 `.env.example` 为 `.env.local`，填写 PostgreSQL 和 Coze 配置。
2. 创建数据库结构：`npm run db:migrate`
3. 临时设置 `EDULAB_ADMIN_PASSWORD`，创建管理员：`npm run admin:create -- researcher`
4. 删除临时的 `EDULAB_ADMIN_PASSWORD`，启动项目：`npm run dev`
5. 打开 `/admin` 配置实验，再生成参与者链接：`npm run participants:link -- P001 P002`

为了本地快速调试，可以临时设置 `ALLOW_UNSIGNED_PARTICIPANTS=true`，然后访问 `http://localhost:3000/?participant=P001`。生产环境必须关闭这个选项，并使用带 `access` 签名的完整链接。

## Coze 配置

智能体必须发布到 API 渠道。国际版通常使用 `https://api.coze.com`，中国区使用与你的 Coze 账号和 Token 匹配的官方 API 地址。EduLab 使用同一个 `conversation_id` 和稳定的会话级 `user_id` 维持多轮上下文，并启用 Coze 的 `auto_save_history` 作为辅助恢复来源；EduLab PostgreSQL 仍然是研究数据的权威记录。

实现依据：[Coze Chat v3](https://www.coze.com/open/docs/developer_guides/chat_v3)、[Retrieve chat](https://www.coze.com/open/docs/developer_guides/retrieve_chat)、[Personal Access Token](https://www.coze.com/open/docs/developer_guides/pat) 和 [Coze 官方 JavaScript SDK](https://github.com/coze-dev/coze-js)。

## 管理后台

管理员从 `/admin` 登录，可以设置：

- 是否提供可选任务说明（默认关闭）
- 任务标题、说明、要求、学习材料、提示和欢迎语
- 是否开放聊天、最多发送次数、每条消息字数和实验时长
- 是否在实验结束时将学生与 AI 的消息正文批量保存到数据库
- Coze API 地址、Bot ID 和 Token

管理员密码使用 scrypt 哈希保存，连续失败会暂时锁定账号。Coze Token 使用 AES-256-GCM 加密后保存到 PostgreSQL，后台不会返回明文。`ADMIN_SESSION_SECRET` 和 `SETTINGS_ENCRYPTION_KEY` 必须作为部署环境密钥长期保存。

每次保存设置都会增加版本并写入管理员审计记录。学生创建 Session 时会保存一份非敏感设置快照，因此之后修改后台设置只影响新 Session，不会改变正在进行或已经完成的实验条件。

学生端默认是对话优先界面，左侧用于新建和切换多个对话，可随时收起。任务说明属于可选功能，默认关闭；后台将其放在设置末位，开启后学生通过聊天页的轻量入口按需查看，不占用对话侧栏。每个对话使用独立的 Coze Conversation 和独立浏览器记录，切换时不会混合消息。次数和时长限制按同一参与者的整次实验累计，不能通过新建对话重置。

学生端会在每条消息显示后按 Session 更新浏览器本地副本，刷新页面会自动合并并恢复记录，同时提供 JSON 导出。导出内容包含参与者编号、Session ID、实验信息、消息顺序、角色、正文、发送时间、AI 回复起止时间和延迟。浏览器存储不是跨设备的中央备份，参与者清除浏览器数据后无法恢复，因此关闭数据库正文保存时必须要求参与者在实验结束前下载并提交记录。

对话过程中不会向 `messages` 表逐条写入正文，因此正文数据库保存不会增加每轮 AI 回复的等待时间。学生点击“完成实验”时，若后台开关开启，服务端会在一个事务中批量保存整段对话并结束 Session；若批量保存失败，浏览器副本不会被清除，学生可以重试或人工导出。

关闭“实验结束时保存对话到数据库”只会停止保存学生和 AI 的消息正文。为维持安全 Session、次数限制、多轮对话和请求幂等，PostgreSQL 仍会保存参与者编号、Session、请求状态、时间和必要的 Coze 标识；该开关不能让 EduLab 在数据库完全断网时继续创建新会话。

数据库连接串不能在后台修改。它是平台最高权限凭证，仍然由 Vercel 环境变量管理；日常实验管理员不需要知道数据库账号。

## Vercel + Neon 部署

1. 将仓库导入 Vercel。
2. 在 Vercel 配置 `.env.example` 中除本地调试项之外的所有变量；`EDULAB_BASE_URL` 改为正式域名。
3. 在部署前对目标 PostgreSQL 执行 `npm run db:migrate`。
4. 建议 Neon 使用 pooled connection string，并保持较小的 `DATABASE_POOL_MAX`。
5. 重新生成正式域名下的参与者链接。

所有 Token、数据库连接串和链接签名密钥都只能放在环境变量中。项目不会从前端返回其他参与者的记录，也没有按 URL 查询聊天记录的接口。

## 数据结构

- `participants`：实验内的研究者分配编号
- `experiment_sessions`：一次参与过程、Coze Conversation、开始/活动/完成时间
- `chat_requests`：每次发送的幂等状态、Coze Chat 标识、失败与恢复信息
- `messages`：按会话内严格递增序号保存的学生和 AI 消息、角色及回复时间
- `admin_users`：管理员账号和密码哈希
- `experiment_settings`：当前实验设置、版本和加密后的 Coze 凭证
- `admin_audit_log`：设置变更和管理员登录记录

`database_message_storage_enabled` 默认开启并被写入 Session 设置快照。无论是否开启，交流过程中 `chat_requests` 只保存运行与恢复所需的非正文元数据；开启时在完成实验后批量填充 `messages` 表，关闭时不写入消息正文。

数据库迁移是普通 SQL，运行时使用标准 `pg` 驱动，因此从 Neon 迁移到其他 PostgreSQL 服务只需迁移数据并更换 `DATABASE_URL`。
