"use client";

import { useState, type FormEvent } from "react";

export function AccessCodeForm({ configured, nextPath }: { configured: boolean; nextPath: string }) {
  const [accessCode, setAccessCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(configured ? "" : "网站尚未配置访问码，请联系管理员。");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessCode || submitting || !configured) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/access/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessCode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? "验证失败，请稍后重试。");
      window.location.replace(nextPath);
    } catch (verificationError) {
      setError(verificationError instanceof Error ? verificationError.message : "验证失败，请稍后重试。");
      setSubmitting(false);
    }
  }

  return (
    <main className="access-page">
      <section className="access-card" aria-labelledby="access-title">
        <div className="access-brand"><span aria-hidden="true">E</span><strong>EduLab</strong></div>
        <div className="access-copy">
          <p>实验访问验证</p>
          <h1 id="access-title">请输入 Access Code</h1>
          <span>输入研究者提供的访问码后即可进入实验。</span>
        </div>
        <form className="access-form" onSubmit={submit}>
          <label htmlFor="access-code">Access Code</label>
          <input
            id="access-code"
            type="password"
            value={accessCode}
            onChange={(event) => setAccessCode(event.target.value)}
            autoComplete="current-password"
            disabled={!configured || submitting}
            placeholder="请输入访问码"
          />
          {error && <p className="access-error" role="alert">{error}</p>}
          <button type="submit" disabled={!configured || !accessCode || submitting}>
            {submitting ? "正在验证…" : "进入实验"}
          </button>
        </form>
      </section>
    </main>
  );
}
