import type { Metadata } from "next";
import "./globals.css";
import "./admin/admin.css";

export const metadata: Metadata = {
  title: "EduLab｜教育实验 AI 交互平台",
  description: "阅读实验任务，与指定 AI 智能体完成连续对话。",
  referrer: "no-referrer",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
