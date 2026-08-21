# EduLab

EduLab 是一个面向教育实验研究的轻量 AI 智能体交互平台。学生可以通过同一个实验首页进入，服务端会为每个新浏览器自动生成内部 Participant ID；学生填写姓名或学号后即可与指定 Coze 智能体连续对话。完整交互实时保存在当前浏览器；数据库保存开启时，AI 回复先展示给学生，再在后台异步整理到标准消息表，并可导出 JSON 作为人工备份。

## 技术方案

- Next.js App Router：学生页面和仅服务端可访问的 API
- Coze 官方 `@coze/api` SDK：非流式创建 Chat、轮询状态并读取最终消息
- 标准 PostgreSQL + `pg`：Neon 可直接使用，也可迁移到任何 PostgreSQL 服务
- HttpOnly 会话 Cookie：浏览器无法读取会话密钥，修改 URL 不能读取其他参与者数据
- 独立参与者身份表：姓名、学号加密保存，通过内部 Participant ID 与交互记录关联
- 请求幂等键 + 会话串行锁：防止重复点击产生重复记录
- Coze Chat/Conversation 标识先落库：刷新或请求中断后可恢复未完成回复
- 可折叠多对话侧栏：同一参与者可以创建和切换多个独立 Coze Conversation

## 本地启动

1. 复制 `.env.example` 为 `.env.local`，填写 PostgreSQL 和 Coze 配置。
2. 创建数据库结构：`npm run db:migrate`
3. 临时设置 `EDULAB_ADMIN_PASSWORD`，创建管理员：`npm run admin:create -- researcher`
4. 删除临时的 `EDULAB_ADMIN_PASSWORD`，启动项目：`npm run dev`
5. 打开 `/admin` 配置实验，再直接访问 `http://localhost:3000/`。

默认共享入口会自动生成 Participant ID，不需要研究者逐个制作链接。如果某项研究需要预先分组或指定编号，仍可运行 `npm run participants:link -- P001 P002` 生成可选的签名链接。`ALLOW_UNSIGNED_PARTICIPANTS=true` 只用于本地调试指定编号链接；生产环境必须保持关闭。

## Coze 配置

智能体必须发布到 API 渠道。国际版通常使用 `https://api.coze.com`，中国区使用与你的 Coze 账号和 Token 匹配的官方 API 地址。EduLab 使用同一个 `conversation_id` 和稳定的会话级 `user_id` 维持多轮上下文，并启用 Coze 的 `auto_save_history` 作为辅助恢复来源；EduLab PostgreSQL 仍然是研究数据的权威记录。

实现依据：[Coze Chat v3](https://www.coze.com/open/docs/developer_guides/chat_v3)、[Retrieve chat](https://www.coze.com/open/docs/developer_guides/retrieve_chat)、[Personal Access Token](https://www.coze.com/open/docs/developer_guides/pat) 和 [Coze 官方 JavaScript SDK](https://github.com/coze-dev/coze-js)。

## 管理后台

管理员从 `/admin` 登录，可以设置：

- 查看 Participant ID 与姓名、学号的身份对应表，以及会话数、交互轮次和最后活动时间
- 是否提供可选任务说明（默认关闭）
- 任务标题、说明、要求、学习材料、提示和欢迎语
- 是否开放聊天、最多发送次数、每条消息字数和实验时长
- 是否在 AI 回复显示后异步保存完整正文到数据库
- Coze API 地址、Bot ID 和 Token

管理员密码使用 scrypt 哈希保存，连续失败会暂时锁定账号。Coze Token 使用 AES-256-GCM 加密后保存到 PostgreSQL，后台不会返回明文。`ADMIN_SESSION_SECRET` 和 `SETTINGS_ENCRYPTION_KEY` 必须作为部署环境密钥长期保存。

每次保存设置都会增加版本并写入管理员审计记录。学生创建 Session 时会保存一份非敏感设置快照，因此之后修改后台设置只影响新 Session，不会改变正在进行或已经完成的实验条件。

学生端默认是对话优先界面，左侧用于新建和切换多个对话，可随时收起。任务说明属于可选功能，默认关闭；后台将其放在设置末位，开启后学生通过聊天页的轻量入口按需查看，不占用对话侧栏。每个对话使用独立的 Coze Conversation 和独立浏览器记录，切换时不会混合消息。次数和时长限制按同一参与者的整次实验累计，不能通过新建对话重置。

学生打开共享首页时，服务端使用安全随机 UUID 自动创建 Participant ID 和独立 HttpOnly Session；不同浏览器同时进入会获得不同编号。随后学生通过左侧栏底部至少填写姓名或学号中的一项，保存后才能发送消息。姓名和学号使用 `SETTINGS_ENCRYPTION_KEY` 加密后存入独立的 `participant_identity_profiles` 表；学生只能通过自己的 Session 读写自己的信息，已登录管理员才能查看对应表。这些直接身份信息不会发送给 Coze，也不会进入 `messages`、`chat_requests` 或学生下载的 JSON。研究分析继续使用 Participant ID，只有需要后续访谈时才通过后台对应到具体学生。

学生端会在参与者点击发送时先同步更新当前 Session 的浏览器本地副本，再请求 AI；AI 回复到达后继续合并写入。刷新页面会同时结合本地副本与 Coze Chat 恢复双方消息，并提供 JSON 导出。导出内容包含参与者编号、Session ID、Coze Conversation / Chat / Message 标识、实验信息、严格消息顺序、对话轮次、角色、正文、发送时间、AI 回复起止时间和延迟。浏览器存储不是跨设备的中央备份，参与者清除浏览器数据后无法恢复，因此关闭数据库正文保存时必须要求参与者在实验结束前下载并提交记录。

数据库保存开启时，每轮学生问题和 AI 回复仍先写入浏览器本地副本及 `chat_requests` 恢复元数据；回复显示后，前端另行发起不阻塞界面的后台检查点，将双方消息幂等整理到 `messages`。达到后台设置的时间或次数限制后，系统自动校验全部轮次并完成最终整理，学生没有主动结束按钮。学生尝试关闭、刷新或离开仍在进行的页面时，浏览器会显示原生离开确认，并在实际离开时使用 Beacon 再上传一次最新检查点。浏览器无法可靠区分关闭与刷新，确认框文字也由浏览器控制。

关闭“后台保存完整对话到数据库”只会停止保存学生和 AI 的消息正文。为维持安全 Session、次数限制、多轮对话和请求幂等，PostgreSQL 仍会保存参与者编号、Session、请求状态、时间和必要的 Coze 标识；该开关不能让 EduLab 在数据库完全断网时继续创建新会话。

数据库连接串不能在后台修改。它是平台最高权限凭证，仍然由 Vercel 环境变量管理；日常实验管理员不需要知道数据库账号。

## Vercel + Neon 部署

1. 将仓库导入 Vercel。
2. 在 Vercel 配置 `.env.example` 中除本地调试项之外的所有变量；`EDULAB_BASE_URL` 改为正式域名。
3. 在部署前对目标 PostgreSQL 执行 `npm run db:migrate`。
4. 建议 Neon 使用 pooled connection string，并保持较小的 `DATABASE_POOL_MAX`。
5. 将正式域名首页作为学生共享入口；如需预先指定编号或实验分组，再额外生成签名链接。

所有 Token、数据库连接串和链接签名密钥都只能放在环境变量中。项目不会从前端返回其他参与者的记录，也没有按 URL 查询聊天记录的接口。

## 数据结构

- `participants`：系统自动生成或研究者预先指定的实验内编号
- `participant_identity_profiles`：与 Participant ID 一对一关联的加密姓名、学号
- `experiment_sessions`：一次参与过程、Coze Conversation、开始/活动/完成时间
- `chat_requests`：每次发送的幂等状态、对话轮次、Coze Chat 标识、失败与恢复信息
- `messages`：按会话内严格递增序号和轮次保存的学生与 AI 全量消息、角色及回复时间
- `admin_users`：管理员账号和密码哈希
- `experiment_settings`：当前实验设置、版本和加密后的 Coze 凭证
- `admin_audit_log`：设置变更和管理员登录记录

`database_message_storage_enabled` 默认开启并被写入 Session 设置快照。开启时，`chat_requests` 在原有状态写入中携带本轮双方正文的恢复副本，回复显示后再异步、幂等地填充 `messages`；关闭时，`chat_requests` 只保存运行与恢复所需的非正文元数据，不写入消息正文。

数据库迁移是普通 SQL，运行时使用标准 `pg` 驱动，因此从 Neon 迁移到其他 PostgreSQL 服务只需迁移数据并更换 `DATABASE_URL`。
