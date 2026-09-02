# EduLab

EduLab 是一个面向教育实验研究的轻量 AI 智能体交互平台。学生通过同一个实验首页进入，先填写姓名或学号，再由服务端按顺序生成内部 Participant ID；随后进入教师当前开放的实验场次，并与该场次指定的 Coze 智能体连续对话。完整交互实时保存在当前浏览器；数据库保存开启时，在实验结束、参与者切换或页面离开时整理到标准消息表，并可导出 JSON 作为人工备份。

学生入口支持共享 Access Code 保护。`ACCESS_CODE` 仅保存在服务端环境变量中，验证成功后由服务端写入带签名的 `HttpOnly` Cookie，默认 7 天内无需重复输入；更换环境变量中的访问码会立即使旧验证 Cookie 失效。学生页面以及 Session、消息、对话和参与者信息 API 都受保护，管理后台继续使用独立的管理员登录。部署到 Vercel 时须在项目环境变量中配置 `ACCESS_CODE`，修改后重新部署。

## 技术方案

- Next.js App Router：学生页面和仅服务端可访问的 API
- Coze 官方 `@coze/api` SDK：非流式创建 Chat、轮询状态并读取最终消息
- 标准 PostgreSQL + `pg`：Neon 可直接使用，也可迁移到任何 PostgreSQL 服务
- HttpOnly 会话 Cookie：浏览器无法读取会话密钥，修改 URL 不能读取其他参与者数据
- 独立参与者身份表：姓名、学号加密保存，通过内部 Participant ID 与交互记录关联
- 加密 HttpOnly 运行配置：参与者进入场次后，发送消息直接调用 Coze，不在回复关键路径等待 PostgreSQL
- 浏览器本地 Outbox 与 Session 串行发送：降低重复点击和网络中断造成的丢失风险
- Coze Chat/Conversation 标识保存在本地记录与结束时数据库备份中
- 可折叠多对话侧栏：同一参与者可以创建和切换多个独立 Coze Conversation

## 本地启动

1. 复制 `.env.example` 为 `.env.local`，填写 PostgreSQL、加密密钥和至少一个可用的 Coze Token。
2. 创建数据库结构：`npm run db:migrate`
3. 临时设置 `EDULAB_ADMIN_PASSWORD`，创建管理员：`npm run admin:create -- researcher`
4. 删除临时的 `EDULAB_ADMIN_PASSWORD`，启动项目：`npm run dev`
5. 打开 `/admin` 配置实验，再直接访问 `http://localhost:3000/`。

默认共享入口会先要求学生填写基本信息，提交后才生成 Participant ID，不需要研究者逐个制作链接。如果某项研究需要预先分组或指定编号，仍可运行 `npm run participants:link -- P001 P002` 生成可选的签名链接。`ALLOW_UNSIGNED_PARTICIPANTS=true` 只用于本地调试指定编号链接；生产环境必须保持关闭。

## Coze 配置

智能体必须发布到 API 渠道。国际版通常使用 `https://api.coze.com`，中国区使用与你的 Coze 账号和 Token 匹配的官方 API 地址。管理员可以在“智能体与场次”中保存多个 Bot ID；每个智能体可使用自己的加密 Token，没有单独填写时仍可使用服务器环境变量中的 `COZE_API_TOKEN`。EduLab 使用同一个 `conversation_id` 和稳定的会话级 `user_id` 维持多轮上下文。

实现依据：[Coze Chat v3](https://www.coze.com/open/docs/developer_guides/chat_v3)、[Retrieve chat](https://www.coze.com/open/docs/developer_guides/retrieve_chat)、[Personal Access Token](https://www.coze.com/open/docs/developer_guides/pat) 和 [Coze 官方 JavaScript SDK](https://github.com/coze-dev/coze-js)。

## 管理后台

管理员从 `/admin` 登录，可以设置：

- 查看 Participant ID 与姓名、学号的身份对应表，以及会话数、交互轮次和最后活动时间
- 是否提供可选任务说明（默认关闭）
- 任务标题、说明、要求、学习材料、提示和欢迎语
- 是否开放聊天、最多发送次数、每条消息字数和实验时长
- 是否在实验结束或离开页面时把完整正文备份到数据库
- 多个 Coze 智能体的内部名称、API 地址、Bot ID、Token 和启用状态
- 当前实验场次、固定智能体或均衡随机分配规则
- 删除测试参与者的整组数据库记录，或删除从未投入场次使用的智能体

管理员密码使用 scrypt 哈希保存，连续失败会暂时锁定账号。Coze Token 使用 AES-256-GCM 加密后保存到 PostgreSQL，后台不会返回明文。`ADMIN_SESSION_SECRET` 和 `SETTINGS_ENCRYPTION_KEY` 必须作为部署环境密钥长期保存。

每次保存设置、智能体或切换场次都会写入管理员审计记录。学生创建 Session 时会锁定场次、智能体和设置快照，因此之后切换场次只影响新参与者，不会改变正在进行或已经完成的实验条件。一个实验只能有一个开放场次；新场次开放时会自动关闭上一个场次。

删除属于危险操作：后台会弹出独立确认框，并要求再次输入 Participant ID 或智能体内部名称。删除参与者时，身份对应、Session、请求轮次、消息和智能体分配会在一个数据库事务中整体删除；对应学生页面在重新获得焦点或再次执行操作时会退出失效 Session，并清除该参与者在该浏览器中的本地对话。为了保持历史研究数据可还原，已经被任何场次、分配或 Session 引用的智能体不能删除，只能停用；未被引用的新增智能体可以永久删除。删除动作会写入不含姓名和学号的管理员审计记录。

学生端默认是对话优先界面，左侧用于新建和切换多个对话，可随时收起。任务说明属于可选功能，默认关闭；后台将其放在设置末位，开启后学生通过聊天页的轻量入口按需查看，不占用对话侧栏。每个对话使用独立的 Coze Conversation 和独立浏览器记录，切换时不会混合消息。次数和时长限制按同一参与者的整次实验累计，不能通过新建对话重置。

学生打开共享首页时先填写姓名或学号中的至少一项，提交后服务端才按实验顺序生成 `P001`、`P002` 等 Participant ID，并在同一个事务中创建独立 HttpOnly Session 和加密身份记录。未填写时刷新页面不会产生空参与者或空会话。姓名和学号使用 `SETTINGS_ENCRYPTION_KEY` 加密后存入独立的 `participant_identity_profiles` 表；学生只能通过自己的 Session 读写自己的信息，已登录管理员才能查看对应表。这些直接身份信息不会发送给 Coze，也不会进入 `messages`、`chat_requests` 或学生下载的 JSON。研究分析继续使用 Participant ID，只有需要后续访谈时才通过后台对应到具体学生。页面开场欢迎语仅为界面提示，不计入消息、轮次或导出记录。

同一台实验设备由多名学生依次使用时，已填写身份的学生可以从左下角身份信息弹窗选择“开始下一位参与者”。系统会先校验当前没有进行中的 AI 回复，并在数据库保存开启时完成当前记录整理；数据库正文保存关闭时会自动下载包含该参与者全部本地对话的 JSON 归档。随后仅清除 Participant Session，保留 Access Code 验证，下一位学生直接填写信息并获得下一个顺序编号。切换操作带有明确确认提示，不出现在主聊天工具栏。

学生端会在参与者点击发送时先同步更新当前 Session 的浏览器本地副本，再请求 AI；AI 回复到达后继续合并写入。刷新页面会同时结合本地副本与 Coze Chat 恢复双方消息，并提供 JSON 导出。导出内容包含参与者编号、Session ID、Coze Conversation / Chat / Message 标识、实验信息、严格消息顺序、对话轮次、角色、正文、发送时间、AI 回复起止时间和延迟。浏览器存储不是跨设备的中央备份，参与者清除浏览器数据后无法恢复，因此关闭数据库正文保存时必须要求参与者在实验结束前下载并提交记录。

聊天期间，每轮学生问题和 AI 回复先写入浏览器本地副本，消息 API 使用进入场次时生成的加密运行配置直接调用 Coze，不等待数据库查询或写入。达到后台设置的时间或次数限制后，系统校验全部轮次并一次性整理到 `chat_requests` 和 `messages`。学生尝试关闭、刷新或离开仍在进行的页面时，浏览器会显示原生离开确认，并在实际离开时使用 Beacon 上传最新记录。浏览器无法可靠区分关闭与刷新，确认框文字也由浏览器控制。

关闭“实验结束时备份完整对话到数据库”只会停止保存学生和 AI 的消息正文。PostgreSQL 仍用于参与者编号、加密身份对应表、场次分配和 Session 创建；因此数据库中断可能阻止新参与者进入、创建新对话或完成云端备份，但不会延迟已经进入场次的学生获得正常 AI 回复。

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
- `ai_agent_configs`：多个 Coze 智能体及其加密凭证
- `experiment_runs`：教师开放和关闭的课程场次及分配规则
- `participant_agent_assignments`：参与者、场次与锁定智能体的对应关系
- `chat_requests`：每次发送的幂等状态、对话轮次、Coze Chat 标识、失败与恢复信息
- `messages`：按会话内严格递增序号和轮次保存的学生与 AI 全量消息、角色及回复时间
- `admin_users`：管理员账号和密码哈希
- `experiment_settings`：当前实验设置、版本和加密后的 Coze 凭证
- `admin_audit_log`：设置变更和管理员登录记录

`database_message_storage_enabled` 默认开启并被写入 Session 设置快照。开启时，实验完成、参与者切换或页面离开会把浏览器中的完整轮次幂等整理到 `chat_requests` 和 `messages`；关闭时不保存消息正文，以人工下载的 JSON 为主。

数据库迁移是普通 SQL，运行时使用标准 `pg` 驱动，因此从 Neon 迁移到其他 PostgreSQL 服务只需迁移数据并更换 `DATABASE_URL`。
