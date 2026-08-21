import type { Metadata } from "next";
import { AdminWorkspace } from "./workspace";

export const metadata: Metadata = {
  title: "实验设置｜EduLab 管理后台",
  description: "配置 EduLab 实验内容、交互限制和 AI 接入。",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <AdminWorkspace />;
}
