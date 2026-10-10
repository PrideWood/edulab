import type { Metadata } from "next";
import "./globals.css";
import "./admin/admin.css";

export const metadata: Metadata = {
  title: "EduLab｜教育实验 AI 交互平台",
  description: "阅读实验任务，与指定 AI 智能体完成连续对话。",
  referrer: "no-referrer",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48 64x64 128x128 256x256", type: "image/x-icon" },
      { url: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
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
