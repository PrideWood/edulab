import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "实验链接提示｜EduLab",
  description: "请使用教师提供的完整实验链接进入 EduLab。",
};

export default function Home() {
  return (
    <main className="access-page">
      <section className="access-card entry-notice" aria-labelledby="entry-notice-title">
        <div className="access-brand"><span aria-hidden="true">E</span><strong>EduLab</strong></div>
        <div className="access-copy">
          <p>实验入口</p>
          <h1 id="entry-notice-title">请使用教师提供的实验链接进入</h1>
          <span>请打开教师发送的完整链接。如尚未收到链接，请联系教师。</span>
        </div>
      </section>
    </main>
  );
}
