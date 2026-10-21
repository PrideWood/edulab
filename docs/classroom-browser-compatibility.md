# 机房浏览器兼容性

现场设备：Windows 10，Chrome 95.0.4638.54（64 位）。

## 构建与代码要求

- `package.json` 的 Browserslist 显式包含 Chrome 95，供 Next.js 的 JavaScript 和 CSS 编译使用。不能依赖框架默认的较新浏览器目标。配置方式见 [Next.js 浏览器支持说明](https://nextjs.org/docs/architecture/supported-browsers)。
- 学生端超时通过 `lib/timeout-signal.ts` 创建，不能直接使用 `AbortSignal.timeout`。兼容路径使用 `AbortController` 和定时器。
- 学生端请求 ID 通过 `lib/client-request-id.ts` 创建。缺少 `crypto.randomUUID` 时使用 `crypto.getRandomValues` 生成 UUID v4，保留幂等请求及重试的隔离，不使用 `Math.random`。
- 聊天外壳固定于视口，Grid 行及消息列表可以收缩；消息在列表内滚动。文字可从 14px 放大到 24px，输入框与外边框不能随消息增长而超出窗口。
- 其他页面以 `vh` 为基础，动态视口单位放在 `@supports` 中。不要仅将 `vh` 和 `dvh` 连写在同一规则里：生产 CSS 压缩可能移除前一项。
- `text-wrap: balance`、`backdrop-filter` 等视觉增强可以在旧浏览器中被忽略，不作为核心功能的前提。

## 验证

1. `npm test`：包含浏览器构建目标、缺少原生超时 API、缺少原生 UUID API、流式解码及记录上传的回归检查。
2. `npm run build` 和 `npm run lint`。
3. `node scripts/check-classroom-layout.mjs`：先构建，再用独立 Chrome 配置加载生产 CSS。在不同窗口尺寸下验证 200 条消息、24px 字号、流式追加和滚动到底部。额外移除动态视口单位，模拟旧浏览器拒绝这些声明。可通过 `CHROME_PATH` 指定浏览器可执行文件。

上述自动化使用本机浏览器和功能缺失模拟，不能等同于 Windows Chrome 95 真机验收。现场需在部署完成后强制刷新，检查首次报名、恢复会话、连续发送、长回复、字号调节、下载及提交记录。使用正常实验入口；无需清除已有实验数据。
