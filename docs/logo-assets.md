# EduLab Logo 资源

- 原图：`public/brand/logo-source.jpg`（1254 × 1254）。
- 透明 PNG：`public/logo.png`。仅圆角底板外围透明；浅绿色底板、试剂瓶和书本内的白色留空均保留。
- SVG：`public/logo.svg`、`public/favicon.svg`。由原图轮廓描摹为真正的 SVG 路径，没有嵌入位图；保留尖角和比例，使用原图五个区域的代表色。JPEG 的细微纹理、颜色噪点不在矢量版中复现。
- 浏览器 ICO：`public/favicon.ico`，内含 16、32、48、64、128、256 像素帧。
- 其他尺寸：`public/favicon-32.png`、`public/apple-touch-icon.png`。

所有网页 Logo 由 `app/brand-logo.tsx` 使用 PNG 展示，浏览器图标通过 `app/layout.tsx` 配置。

## 处理与复现

首先使用内置 imagegen 的 background-extraction 模式生成透明化版本。检查发现外围有白色残点，因此最终网页资源以原图为基础，通过原图描摹出的圆角底板轮廓生成抗锯齿透明蒙版。完全不透明的内部 RGB 像素不变；仅对外围部分透明像素去除原有白底混色。PNG 保留原始纹理，SVG 使用路径近似。

运行 `node scripts/generate-logo-assets.mjs` 可从保留的 JPEG 复现所有资源；使用项目安装的 sharp（Next.js 图片依赖）。

内置 imagegen 提示词：

> Use case: background-extraction. Edit target: attached original EduLab logo. Remove ONLY the exterior near-white background outside the existing pale mint green rounded square panel, making that exterior truly transparent. Preserve the pale mint rounded square panel itself completely; preserve all off-white interior negative space within the flask and book, the dark green flask and book contours, the medium green molecule and pale green liquid. Strictly preserve the exact original geometry, proportions, positioning, colors and structure. Do not redesign, redraw, simplify, recolor, sharpen the internal texture, add shadows or crop the logo. Keep smooth antialiased edge alpha without white halo. Save transparent PNG. This logo must remain faithful to original and recognizable against a dark green sidebar.

## 显示检查

首页在 1280、375、320 像素宽度下检查；提示文字居中，窄屏均衡换行。侧边栏检查页直接服务端渲染当前 `AdminWorkspace` 组件，并注入空的预览状态，使用当前项目 CSS，未读取或修改数据库。Logo 在实际 34 × 34 像素尺寸和 `#17241e` 侧边栏背景中清晰可辨，保留浅绿底板以提供对比。

检查截图保存在忽略提交的 `outputs/logo-review/`。临时检查页面在完成后删除。
