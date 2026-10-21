"use client";

import { useRef, useState, type FormEvent } from "react";
import { verifyAccessCode } from "@/lib/access-verification";
import { requestExperimentFullscreen } from "../fullscreen-controller";
import { BrandLogo } from "../brand-logo";

export function AccessCodeForm({ configured, nextPath }: { configured: boolean; nextPath: string }) {
  const [accessCode, setAccessCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState(1);
  const inFlight = useRef(false);
  const [error, setError] = useState(configured ? "" : "网站尚未配置访问码，请联系管理员。");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessCode || inFlight.current || !configured) return;
    inFlight.current = true;
    setSubmitting(true);
    setAttempt(1);
    setError("");
    try {
      // Fullscreen must be requested while the submit click still counts as a user gesture.
      // The experiment workspace will offer a fallback if navigation exits fullscreen.
      void requestExperimentFullscreen();
      await verifyAccessCode(accessCode,setAttempt);
      window.location.replace(nextPath);
    } catch (verificationError) {
      setError(verificationError instanceof Error ? verificationError.message : "验证失败，请稍后重试。");
      setSubmitting(false);
      inFlight.current = false;
    }
  }

  return (
    <main className="access-page">
      <section className="access-card" aria-labelledby="access-title">
        <div className="access-brand"><BrandLogo size={42} /><strong>EduLab</strong></div>
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
            {submitting ? attempt > 1 ? `正在重试验证（${attempt}/3）…` : "正在验证…" : "进入实验"}
          </button>
        </form>
      </section>
    </main>
  );
}
