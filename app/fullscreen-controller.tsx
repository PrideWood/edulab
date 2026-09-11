"use client";

import { useState, useSyncExternalStore } from "react";

type FullscreenState = "unsupported" | "windowed" | "fullscreen";

function subscribeToFullscreen(callback: () => void) {
  document.addEventListener("fullscreenchange", callback);
  return () => document.removeEventListener("fullscreenchange", callback);
}

function getFullscreenState(): FullscreenState {
  if (!document.fullscreenEnabled || typeof document.documentElement.requestFullscreen !== "function") return "unsupported";
  return document.fullscreenElement ? "fullscreen" : "windowed";
}

function getServerFullscreenState(): FullscreenState {
  return "unsupported";
}

export async function requestExperimentFullscreen() {
  if (document.fullscreenElement) return true;
  if (!document.fullscreenEnabled) return false;

  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    return true;
  } catch {
    return false;
  }
}

export function FullscreenController() {
  const fullscreenState = useSyncExternalStore(subscribeToFullscreen, getFullscreenState, getServerFullscreenState);
  const [requesting, setRequesting] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);

  async function enterFullscreen() {
    setRequesting(true);
    setRequestFailed(false);
    const entered = await requestExperimentFullscreen();
    setRequesting(false);
    setRequestFailed(!entered);
  }

  if (fullscreenState !== "windowed") return null;

  return (
    <div className="fullscreen-backdrop" role="presentation">
      <section className="fullscreen-dialog" role="dialog" aria-modal="true" aria-labelledby="fullscreen-title">
        <div className="fullscreen-icon" aria-hidden="true">⛶</div>
        <p>专注实验模式</p>
        <h1 id="fullscreen-title">请进入全屏后开始实验</h1>
        <span>全屏将隐藏浏览器标签页和其他界面，减少实验过程中的干扰。</span>
        {requestFailed && <div className="fullscreen-error" role="alert">浏览器未能进入全屏，请再次点击按钮或检查浏览器权限。</div>}
        <button type="button" onClick={enterFullscreen} disabled={requesting}>
          {requesting ? "正在进入…" : requestFailed ? "重新进入全屏" : "进入全屏实验"}
        </button>
      </section>
    </div>
  );
}
