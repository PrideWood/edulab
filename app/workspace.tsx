"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StoredMessage } from "@/db/schema";
import type { ExperimentConfig } from "@/config/experiment";
import type { ParticipantProfile, SessionPayload } from "@/lib/client-types";
import { includeBrowserTranscriptBackups, safeExportSegment, type ParticipantTranscriptArchive } from "@/lib/transcript-export";
import { uploadTranscript } from "@/lib/transcript-upload";
import { FullscreenController, useFullscreenState } from "./fullscreen-controller";
import { BrandLogo } from "./brand-logo";
import { readChatStream } from "@/lib/chat-stream";
import { interactionStartKey, readInteractionStart, startLoginInteraction, type InteractionStartAction } from "@/lib/interaction-start";

const OUTBOX_PREFIX = "edulab_pending_message:";
const TRANSCRIPT_PREFIX = "edulab_transcript:";

interface ConversationSummary {
  id: string;
  title: string;
  status: "active" | "completed";
  startedAt: string;
  lastActivityAt: string;
}

function outboxKey(sessionId: string) {
  return `${OUTBOX_PREFIX}${sessionId}`;
}

function transcriptKey(sessionId: string) {
  return `${TRANSCRIPT_PREFIX}${sessionId}`;
}

function mergeMessages(...groups: StoredMessage[][]) {
  const merged = new Map<number, StoredMessage>();
  for (const message of groups.flat()) {
    const existing = merged.get(message.sequenceNo);
    if (!existing || existing.id.startsWith("pending-") || !message.id.startsWith("pending-")) merged.set(message.sequenceNo, message);
  }
  return [...merged.values()].sort((a, b) => a.sequenceNo - b.sequenceNo || new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
}

function readLocalTranscript(sessionId: string): StoredMessage[] {
  try {
    const raw = localStorage.getItem(transcriptKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { messages?: StoredMessage[] };
    if (!Array.isArray(parsed.messages)) return [];
    let inferredTurn = 0;
    return [...parsed.messages]
      .sort((a, b) => a.sequenceNo - b.sequenceNo)
      .map((message) => {
        if (Number.isInteger(message.turnIndex) && message.turnIndex > 0) {
          inferredTurn = message.turnIndex;
          return { ...message, cozeMessageId: message.cozeMessageId ?? null, cozeChatId: message.cozeChatId ?? null };
        }
        if (message.role === "user") inferredTurn += 1;
        return { ...message, turnIndex: Math.max(1, inferredTurn), cozeMessageId: message.cozeMessageId ?? null, cozeChatId: message.cozeChatId ?? null };
      });
  } catch { return []; }
}

function writeLocalTranscript(activeSession: SessionPayload["session"], messages: StoredMessage[], experimentId: string) {
  try {
    localStorage.setItem(transcriptKey(activeSession.id), JSON.stringify({
      version: 3,
      experimentId,
      sessionId: activeSession.id,
      participantCode: activeSession.participantCode,
      updatedAt: new Date().toISOString(),
      messages,
    }));
  } catch {
    window.dispatchEvent(new Event("edulab-storage-error"));
  }
}

function transcriptUploadBody(messages: StoredMessage[]) {
  return JSON.stringify({
    messages: messages.map((message) => ({
      sequenceNo: message.sequenceNo,
      role: message.role,
      content: message.content,
      turnIndex: message.turnIndex,
      sentAt: message.sentAt,
      replyStartedAt: message.replyStartedAt,
      replyCompletedAt: message.replyCompletedAt,
      latencyMs: message.latencyMs,
      clientRequestId: message.clientRequestId,
      cozeMessageId: message.cozeMessageId,
      cozeChatId: message.cozeChatId,
      ...(message.provider === "dify" ? {provider: message.provider, providerMessageId: message.providerMessageId ?? null, providerTaskId: message.providerTaskId ?? null} : {}),
    })),
  });
}

function downloadFile(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function readResponse(response: Response): Promise<SessionPayload> {
  const data = await response.json().catch(() => null);
  if (!data) throw new ClientApiError(response.status, "INVALID_RESPONSE", "服务响应中断，请稍后重试；本地记录仍保留。");
  if (!response.ok) throw new ClientApiError(response.status, data?.error?.code ?? "REQUEST_FAILED", data?.error?.message ?? "请求失败，请稍后重试。");
  return data;
}

class ClientApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function isInvalidSessionError(error: unknown) {
  return error instanceof ClientApiError && error.status === 401 && ["SESSION_REQUIRED", "SESSION_REPLACED"].includes(error.code);
}

function clearLocalParticipantData(participantCode: string, currentSessionId: string | null, experimentId: string, includeLegacy: boolean) {
  const sessionIds = new Set<string>(currentSessionId ? [currentSessionId] : []);
  const transcriptKeys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(TRANSCRIPT_PREFIX)) continue;
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "{}") as { participantCode?: string; sessionId?: string; experimentId?: string };
      if (saved.participantCode !== participantCode || (saved.experimentId ? saved.experimentId !== experimentId : !includeLegacy)) continue;
      transcriptKeys.push(key);
      if (saved.sessionId) sessionIds.add(saved.sessionId);
    } catch { /* Ignore unrelated or malformed browser data. */ }
  }
  for (const key of transcriptKeys) localStorage.removeItem(key);
  for (const sessionId of sessionIds) {
    localStorage.removeItem(outboxKey(sessionId));
    localStorage.removeItem(`edulab_draft:${sessionId}`);
    localStorage.removeItem(transcriptKey(sessionId));
  }
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function MessageBody({ message }: { message: Pick<StoredMessage, "role" | "content"> }) {
  if (message.role === "user") return <>{message.content}</>;
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>,
        }}
      >
        {message.content}
      </ReactMarkdown>
    </div>
  );
}

export function ExperimentWorkspace({ experiment: initialExperiment, entryToken, rosterClasses }: { experiment: ExperimentConfig; entryToken?: string; rosterClasses?: string[] }) {
  const experimentId = initialExperiment.id;
  const apiUrl = useCallback((path: string) => entryToken ? `${path}?entry=${encodeURIComponent(entryToken)}` : path, [entryToken]);
  const [experiment, setExperiment] = useState(initialExperiment);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [session, setSession] = useState<SessionPayload["session"] | null>(null);
  const [controls, setControls] = useState<SessionPayload["controls"] | null>(null);
  const [clock, setClock] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [streamingReply, setStreamingReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState("");
  const uploadRef = useRef(false);
  const sendingRef = useRef(false);
  const [retryContent, setRetryContent] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [conversationBusy, setConversationBusy] = useState(false);
  const [loginStartPending, setLoginStartPending] = useState(false);
  const loginRequestRef = useRef(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [participantProfile, setParticipantProfile] = useState<ParticipantProfile | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileFullName, setProfileFullName] = useState("");
  const [profileStudentNumber, setProfileStudentNumber] = useState("");
  const [rosterClass, setRosterClass] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [participantSwitching, setParticipantSwitching] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [entryMode, setEntryMode] = useState<"new" | "resume">("new");
  const [resumeCode, setResumeCode] = useState("");
  const [resumeIdentity, setResumeIdentity] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [codeNoticeOpen,setCodeNoticeOpen] = useState(false);
  const [newInteractionOpen,setNewInteractionOpen] = useState(false);
  const registrationRequestRef = useRef<string | null>(null);
  const [draftStatus, setDraftStatus] = useState("");
  const [draftConflict, setDraftConflict] = useState(false);
  const draftRef = useRef({ sessionId: "", text: "", savedText: "", revision: 0, conflict: false });
  const draftSaveRef = useRef<Promise<void> | null>(null);
  const databaseMessagesEnabledRef = useRef(false);
  const [finalizationRetry, setFinalizationRetry] = useState(0);
  const fullscreenState = useFullscreenState();
  const messagesViewRef = useRef<HTMLDivElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const messageLedgerRef = useRef<StoredMessage[]>([]);
  const activeSessionRef = useRef<SessionPayload["session"] | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const automaticCompletionRef = useRef<string | null>(null);
  const hasAutoFocusedComposerRef = useRef(false);
  const restoreComposerFocusRef = useRef(false);

  const clearInvalidatedSession = useCallback((notice: string) => {
    const previousSession = activeSessionRef.current;
    if (previousSession && notice.includes("后台删除")) clearLocalParticipantData(previousSession.participantCode, previousSession.id, experimentId, !entryToken);
    sessionIdRef.current = null;
    activeSessionRef.current = null;
    messageLedgerRef.current = [];
    automaticCompletionRef.current = null;
    setSession(null);
    setMessages([]);
    setControls(null);
    setConversations([]);
    setParticipantProfile(null);
    setCodeNoticeOpen(false);
    setNewInteractionOpen(false);
    setLoginStartPending(false);
    setProfileFullName("");
    setProfileStudentNumber("");
    setText("");
    draftRef.current = { sessionId: "", text: "", savedText: "", revision: 0, conflict: false };
    databaseMessagesEnabledRef.current = false;
    setDraftStatus("");
    setDraftConflict(false);
    setEntryMode("resume");
    setPending(false);
    setRetryContent(null);
    setError(null);
    setTaskOpen(false);
    setDownloadStatus("");
    setProfileError(notice);
    setProfileOpen(true);
    setLoading(false);
    hasAutoFocusedComposerRef.current = false;
    restoreComposerFocusRef.current = false;
    window.history.replaceState({}, "", window.location.pathname);
  }, [experimentId, entryToken]);

  const releaseInvalidatedSession = useCallback(async (notice = "会话已失效或已在其他窗口恢复，请使用实验编号继续。") => {
    const transcript = transcriptUploadBody(messageLedgerRef.current);
    clearInvalidatedSession(notice);
    if (!notice.includes("后台删除")) return;
    try {
      await fetch(apiUrl("/api/sessions/reset"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: transcript,
      });
    } catch { /* Local cleanup must still continue when the deleted server record is unavailable. */ }
  }, [clearInvalidatedSession, apiUrl]);

  const applyPayload = useCallback((payload: SessionPayload) => {
    const changedSession = sessionIdRef.current !== null && sessionIdRef.current !== payload.session.id;
    sessionIdRef.current = payload.session.id;
    activeSessionRef.current = payload.session;
    setSession(payload.session);
    databaseMessagesEnabledRef.current = payload.controls.databaseMessagesEnabled;
    if (payload.experiment) setExperiment(payload.experiment);
    if (draftRef.current.sessionId !== payload.session.id) {
      let draftText = payload.draft?.text ?? "";
      let conflict = false;
      try {
        const local = JSON.parse(localStorage.getItem(`edulab_draft:${payload.session.id}`) ?? "null");
        if (local?.revision === payload.draft?.revision && typeof local.text === "string") draftText = local.text;
        else if (typeof local?.text === "string" && local.text !== local.savedText && local.text !== draftText) {
          draftText = local.text;
          conflict = true;
        }
      } catch { /* The server remains authoritative when local storage is unavailable. */ }
      draftRef.current = { sessionId: payload.session.id, text: draftText, savedText: payload.draft?.text ?? "", revision: payload.draft?.revision ?? 0, conflict };
      setText(draftText);
      setDraftConflict(conflict);
      setDraftStatus(conflict ? "本机仍有未确认保存的草稿，已保留在输入框，请核对后选择要保留的内容。" : "");
    } else if (payload.draft && !draftSaveRef.current) {
      const draft = draftRef.current;
      if (draft.text === draft.savedText || draft.text === payload.draft.text) {
        draft.revision = payload.draft.revision;
        draft.savedText = payload.draft.text;
        draft.text = payload.draft.text;
        setText(payload.draft.text);
      } else if (payload.draft.revision !== draft.revision) {
        draft.conflict = true;
        setDraftConflict(true);
        setDraftStatus("云端草稿已变化，当前输入尚未保存，请保留输入并刷新核对。");
      }
    }
    setParticipantProfile(payload.participantProfile);
    if (!payload.participantProfile) setProfileOpen(true);
    const localMessages = readLocalTranscript(payload.session.id);
    const mergedMessages = mergeMessages(localMessages, changedSession ? [] : messageLedgerRef.current, payload.messages);
    messageLedgerRef.current = mergedMessages;
    setMessages(mergedMessages);
    writeLocalTranscript(payload.session, mergedMessages, experimentId);
    setPending(payload.pending);
    setStreamingReply("");
    setControls(payload.controls);
    if (payload.failedRequest) {
      setError(payload.failedRequest.message);
      setRetryContent(payload.failedRequest.retryable === false ? null : payload.failedRequest.content);
      localStorage.removeItem(outboxKey(payload.session.id));
    } else if (!payload.pending) {
      const raw = localStorage.getItem(outboxKey(payload.session.id));
      if (raw) {
        try {
          const saved = JSON.parse(raw) as { clientRequestId?: string };
          if (saved.clientRequestId && payload.messages.some((message) => message.clientRequestId === saved.clientRequestId)) localStorage.removeItem(outboxKey(payload.session.id));
        } catch { localStorage.removeItem(outboxKey(payload.session.id)); }
      }
    }
  }, [experimentId]);

  const saveDraft = useCallback(async () => {
    if (!databaseMessagesEnabledRef.current) return;
    if (draftSaveRef.current || sendingRef.current) return draftSaveRef.current;
    const draft = draftRef.current;
    if (!draft.sessionId || draft.text === draft.savedText || draft.conflict || activeSessionRef.current?.status !== "active") return;
    const snapshot = { ...draft };
    const work = (async () => {
      try {
        setDraftStatus("草稿保存中…");
        const response = await fetch(apiUrl("/api/sessions/draft"), {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: snapshot.sessionId, text: snapshot.text, revision: snapshot.revision }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await response.json();
        if (!response.ok) throw new ClientApiError(response.status, data?.error?.code ?? "DRAFT_FAILED", data?.error?.message ?? "草稿保存失败");
        if (draftRef.current !== draft) return;
        draft.revision = data.draft.revision;
        draft.savedText = snapshot.text;
        try { localStorage.setItem(`edulab_draft:${snapshot.sessionId}`, JSON.stringify({ text: draft.text, savedText: draft.savedText, revision: draft.revision })); } catch { setStorageError(true); }
        setDraftStatus(draft.text === draft.savedText ? "草稿已保存" : "草稿待保存");
      } catch (saveError) {
        if (draftRef.current !== draft) return;
        draft.conflict = saveError instanceof ClientApiError && (saveError.status === 409 || saveError.status === 401);
        setDraftConflict(draft.conflict);
        setDraftStatus(saveError instanceof Error ? `${saveError.message}（当前输入未确认保存）` : "草稿保存失败，请保留输入并重试");
      }
    })();
    draftSaveRef.current = work;
    try { await work; } finally { draftSaveRef.current = null; }
  }, [apiUrl]);

  function updateComposer(value: string) {
    setText(value);
    draftRef.current.text = value;
    try { localStorage.setItem(`edulab_draft:${draftRef.current.sessionId}`, JSON.stringify({ text: value, savedText: draftRef.current.savedText, revision: draftRef.current.revision })); } catch { setStorageError(true); }
  }

  async function resolveDraftConflict(keepLocal: boolean) {
    setDraftStatus("正在核对草稿…");
    try {
      const payload = await readResponse(await fetch(apiUrl("/api/sessions"), { cache: "no-store" }));
      if (payload.session.id !== sessionIdRef.current) throw new Error("会话已变化，请在最新恢复的窗口继续。");
      draftRef.current.revision = payload.draft?.revision ?? 0;
      draftRef.current.savedText = payload.draft?.text ?? "";
      draftRef.current.conflict = false;
      setDraftConflict(false);
      if (keepLocal) await saveDraft();
      else { updateComposer(payload.draft?.text ?? ""); setDraftStatus("已恢复云端草稿"); }
    } catch (draftError) { setDraftStatus(draftError instanceof Error ? draftError.message : "草稿核对失败，请保留输入并重试。"); }
  }

  useEffect(() => {
    if (!session || !controls?.databaseMessagesEnabled || pending || loading || draftRef.current.text === draftRef.current.savedText) return;
    const timer = window.setTimeout(() => { void saveDraft(); }, 900);
    return () => window.clearTimeout(timer);
  }, [text, session, controls?.databaseMessagesEnabled, pending, loading, saveDraft]);

  useEffect(() => {
    const retry = () => { void saveDraft(); };
    const saveBeforeLeaving = () => {
      const draft = draftRef.current;
      if (!draft.sessionId || draft.conflict || draftSaveRef.current || draft.text === draft.savedText || activeSessionRef.current?.status !== "active") return;
      const body = JSON.stringify({ sessionId: draft.sessionId, text: draft.text, revision: draft.revision });
      if (new Blob([body]).size <= 48_000) navigator.sendBeacon(apiUrl("/api/sessions/draft"), new Blob([body], { type: "application/json" }));
    };
    window.addEventListener("online", retry);
    window.addEventListener("pagehide", saveBeforeLeaving);
    const interval = window.setInterval(retry, 15000);
    return () => { window.removeEventListener("online", retry); window.removeEventListener("pagehide", saveBeforeLeaving); window.clearInterval(interval); };
  }, [saveDraft, apiUrl]);

  const refreshConversations = useCallback(async () => {
    const response = await fetch(apiUrl("/api/conversations"), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) {
      const responseError = new ClientApiError(response.status, data?.error?.code ?? "REQUEST_FAILED", data?.error?.message ?? "无法读取对话列表。");
      if (isInvalidSessionError(responseError)) {
        await releaseInvalidatedSession();
        return false;
      }
      throw responseError;
    }
    setConversations(data.conversations as ConversationSummary[]);
    return true;
  }, [releaseInvalidatedSession, apiUrl]);

  const pollUntilSettled = useCallback(async () => {
    const expectedSessionId = sessionIdRef.current;
    if (!expectedSessionId) return;
    const deadline = Date.now() + 5 * 60_000;
    for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 1500 + attempt * 150) + Math.random() * 700));
      if (sessionIdRef.current !== expectedSessionId) return;
      let payload: SessionPayload;
      try {
        const response = await fetch(apiUrl("/api/sessions"), { cache: "no-store", signal: AbortSignal.timeout(35000) });
        payload = await readResponse(response);
      } catch (pollError) {
        if (pollError instanceof ClientApiError && pollError.status < 500 && pollError.status !== 429) throw pollError;
        if (pollError instanceof ClientApiError && pollError.code === "COZE_FAILED") throw pollError;
        continue;
      }
      if (sessionIdRef.current !== expectedSessionId || payload.session.id !== expectedSessionId) {
        await releaseInvalidatedSession();
        return;
      }
      applyPayload(payload);
      if (!payload.pending) {
        return;
      }
    }
    setError("AI 仍在处理这条消息。你可以稍后刷新页面，系统会继续恢复结果。");
  }, [applyPayload, releaseInvalidatedSession, apiUrl]);

  const requestConversationChange = useCallback(async (action: {action:"create"} | {action:"switch";sessionId:string} | InteractionStartAction) => {
    const response = await fetch(apiUrl("/api/conversations"), {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(action),
    });
    const data = await response.json();
    if (!response.ok) throw new ClientApiError(response.status, data?.error?.code ?? "REQUEST_FAILED", data?.error?.message ?? "暂时无法切换对话。");
    return data as {payload:SessionPayload;conversations:ConversationSummary[]};
  }, [apiUrl]);

  const finishLoginInteraction = useCallback(async (payload: SessionPayload, retryOnly = false) => {
    const key = interactionStartKey(entryToken ?? experimentId,payload.session.participantCode);
    if (retryOnly && !readInteractionStart(localStorage,key)?.automaticLogin) return;
    setLoginStartPending(true);
    setConversationBusy(true);
    setError(null);
    try {
      const result = await startLoginInteraction({
        storage:localStorage, key, sessionId:payload.session.id, retryOnly,
        newRequestId:()=>crypto.randomUUID(),
        prepare:async () => {
          if (payload.pending) await pollUntilSettled();
          const restored = await readResponse(await fetch(apiUrl("/api/sessions"),{cache:"no-store"}));
          if (restored.session.id !== payload.session.id) throw new ClientApiError(409,"SESSION_CHANGED","当前会话已改变，请刷新后核对，系统未重复创建交互。");
          applyPayload(restored);
          if (restored.pending) throw new Error("上次 AI 回复仍在恢复，请稍后重试开启新交互。");
          if (restored.controls.databaseMessagesEnabled && restored.session.status === "active") {
            await saveDraft();
            if (draftRef.current.text !== draftRef.current.savedText) throw new Error("当前草稿尚未保存，请核对草稿提示后重试开启新交互。");
          }
        },
        start:requestConversationChange,
      });
      if (result) {
        applyPayload(result.payload);
        if (!result.payload.failedRequest) { setError(null); setRetryContent(null); }
        setConversations(result.conversations);
        setTaskOpen(false);
        setLoginStartPending(false);
      }
    } catch (startError) {
      if (isInvalidSessionError(startError)) await releaseInvalidatedSession();
      if (startError instanceof ClientApiError && ["SESSION_CHANGED","NEWER_INTERACTION_EXISTS"].includes(startError.code)) {
        try { localStorage.removeItem(key); } catch { /* No additional start will be attempted with a new request ID. */ }
        setLoginStartPending(false);
        await refreshConversations().catch(() => undefined);
      }
      throw startError;
    } finally { setConversationBusy(false); }
  }, [entryToken,experimentId,pollUntilSettled,apiUrl,applyPayload,saveDraft,requestConversationChange,releaseInvalidatedSession,refreshConversations]);

  const sendWithId = useCallback(async (content: string, clientRequestId: string) => {
    if (sendingRef.current || uploadRef.current) return;
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) return;
    sendingRef.current = true;
    try {
    restoreComposerFocusRef.current = true;
    setError(null);
    setRetryContent(null);
    setUploadStatus("");
    setPending(true);
    setStreamingReply("");
    const turnIndex = Math.max(0, ...messageLedgerRef.current.map((message) => message.turnIndex ?? 0)) + 1;
    const userSequence = Math.max(0, ...messageLedgerRef.current.filter((message) => message.sequenceNo < Number.MAX_SAFE_INTEGER).map((message) => message.sequenceNo)) + 1;
    try { localStorage.setItem(outboxKey(activeSessionId), JSON.stringify({ content, clientRequestId })); }
    catch { setStorageError(true); }
    if (!messageLedgerRef.current.some((message) => message.clientRequestId === clientRequestId)) {
      const optimisticMessage: StoredMessage = {
        id: `pending-${clientRequestId}`,
        sequenceNo: userSequence,
        turnIndex,
        role: "user",
        content,
        sentAt: new Date().toISOString(), replyStartedAt: null, replyCompletedAt: null,
        latencyMs: null, clientRequestId, cozeMessageId: null, cozeChatId: null, status: "completed",
      };
      const nextMessages = mergeMessages(messageLedgerRef.current, [optimisticMessage]);
      messageLedgerRef.current = nextMessages;
      setMessages(nextMessages);
      if (activeSessionRef.current) writeLocalTranscript(activeSessionRef.current, nextMessages, experimentId);
    }
    try {
      const response = await fetch(apiUrl("/api/messages"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, clientRequestId, turnIndex, userSequence }),
        signal: AbortSignal.timeout(65000),
      });
      const payload = response.ok && response.headers.get("content-type")?.includes("text/event-stream")
        ? await readChatStream(response, { sessionId: activeSessionId, clientRequestId,
          onAnswer: answer => { if (sessionIdRef.current === activeSessionId) setStreamingReply(answer); } })
        : await readResponse(response);
      if (sessionIdRef.current !== activeSessionId || payload.session.id !== activeSessionId) {
        await releaseInvalidatedSession();
        return;
      }
      applyPayload(payload);
      if (!payload.pending) {
        localStorage.removeItem(outboxKey(payload.session.id));
      }
      if (payload.pending) await pollUntilSettled();
    } catch (sendError) {
      if (isInvalidSessionError(sendError)) {
        await releaseInvalidatedSession();
        return;
      }
      setPending(false);
      setRetryContent(content);
      setError(sendError instanceof Error ? sendError.message : "发送失败，请重试。");
      try {
        const recovered = await readResponse(await fetch(apiUrl("/api/sessions"), { cache: "no-store" }));
        applyPayload(recovered);
        if (recovered.pending) await pollUntilSettled();
        const recoveredUser = messageLedgerRef.current.find(message => message.clientRequestId === clientRequestId);
        if (recoveredUser && messageLedgerRef.current.some(message => message.role === "assistant" && message.turnIndex === recoveredUser.turnIndex)) {
          setRetryContent(null);
          setError(null);
        }
        if (!recovered.messages.some(message => message.clientRequestId === clientRequestId)) {
          draftRef.current.text = content;
          setText(content);
        }
      } catch {
        draftRef.current.text = content;
        setText(content);
        // Keep the outbox and input for a later retry; do not claim cloud persistence.
      }
    }
    } finally { sendingRef.current = false; setStreamingReply(""); }
  }, [applyPayload, pollUntilSettled, releaseInvalidatedSession, apiUrl, experimentId]);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      const params = new URLSearchParams(window.location.search);
      const participantCode = params.get("participant");
      const access = params.get("access") ?? undefined;
      if (!participantCode) {
        try {
          const response = await fetch(apiUrl("/api/sessions"), { cache: "no-store" });
          if (response.status === 401) {
            if (!cancelled) setProfileOpen(true);
            return;
          }
          const payload = await readResponse(response);
          if (!cancelled) {
            applyPayload(payload);
            await finishLoginInteraction(payload,true);
            const valid = await refreshConversations().catch(() => undefined);
            if (valid === false) return;
            if (payload.pending) await pollUntilSettled();
          }
        } catch (initialError) {
          if (!cancelled) setError(initialError instanceof Error ? initialError.message : "暂时无法进入实验，请稍后重试。");
        }
        finally { if (!cancelled) setLoading(false); }
        return;
      }
      try {
        const payload = await readResponse(await fetch(apiUrl("/api/sessions"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participantCode, access }),
        }));
        if (cancelled) return;
        applyPayload(payload);
        const valid = await refreshConversations().catch(() => undefined);
        if (valid === false) return;
        window.history.replaceState({}, "", window.location.pathname);
        if (payload.pending) await pollUntilSettled();
        const outbox = localStorage.getItem(outboxKey(payload.session.id));
        if (outbox && !payload.pending && payload.session.status === "active") {
          const saved = JSON.parse(outbox) as { content?: string; clientRequestId?: string };
          if (saved.content && saved.clientRequestId && !payload.messages.some((message) => message.clientRequestId === saved.clientRequestId)) {
            setRetryContent(saved.content);
            setError("上一条消息尚未确认回复，请先检查记录，再决定是否重新发送。");
          }
        }
      } catch (initialError) {
        if (!cancelled) {
          setError(initialError instanceof Error ? initialError.message : "无法进入实验，请检查链接。");
          if (initialError instanceof ClientApiError && initialError.code === "PARTICIPANT_EXISTS") {
            setResumeCode(participantCode ?? ""); setEntryMode("resume"); setProfileOpen(true);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialize();
    return () => { cancelled = true; };
  }, [applyPayload, pollUntilSettled, refreshConversations, finishLoginInteraction, apiUrl]);

  useEffect(() => {
    let checking = false;
    async function validateWhenReturning() {
      if (checking || document.visibilityState !== "visible" || !activeSessionRef.current) return;
      checking = true;
      try { await refreshConversations(); }
      catch { /* A temporary database outage must not interrupt the existing AI conversation. */ }
      finally { checking = false; }
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") void validateWhenReturning();
    }
    window.addEventListener("focus", validateWhenReturning);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", validateWhenReturning);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshConversations]);

  useEffect(() => {
    if (!("BroadcastChannel" in window)) return;
    const channel = new BroadcastChannel("edulab_session_events");
    channel.onmessage = (event: MessageEvent<{ type?: string; participantCode?: string; experimentId?: string }>) => {
      if (event.data?.type === "participant_deleted" && event.data.experimentId === experiment.id && event.data.participantCode === activeSessionRef.current?.participantCode) {
        void releaseInvalidatedSession("原参与者记录已从后台删除，请填写下一位参与者信息。");
      }
    };
    return () => channel.close();
  }, [releaseInvalidatedSession, experiment.id, apiUrl]);

  useEffect(() => {
    const container = messagesViewRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [messages, pending, streamingReply]);
  useEffect(() => {
    if (!controls?.endsAt || session?.status !== "active") return;
    const initial = window.setTimeout(() => setClock(Date.now()), 0);
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [controls?.endsAt, session?.status]);

  const remainingSeconds = controls?.endsAt && clock > 0 ? Math.max(0, Math.ceil((new Date(controls.endsAt).getTime() - clock) / 1000)) : null;
  const timeExpired = remainingSeconds === 0;
  const messageLimitReached = controls?.remainingMessages === 0;
  const canChat = Boolean(participantProfile && session?.status === "active" && controls?.chatEnabled && !timeExpired && !messageLimitReached && !conversationBusy && !loginStartPending);
  const fullscreenReady = fullscreenState === "fullscreen" || fullscreenState === "unsupported";
  const composerAvailable = Boolean(canChat && !loading && !pending && !profileOpen && fullscreenReady);
  const limitText = [
    controls?.remainingMessages === null || controls?.remainingMessages === undefined ? null : `剩余 ${controls.remainingMessages} 次`,
    remainingSeconds === null ? null : `剩余 ${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`,
  ].filter(Boolean).join(" · ");

  const focusComposer = useCallback(() => {
    return window.requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input || input.disabled) return;
      input.focus({ preventScroll: true });
      hasAutoFocusedComposerRef.current = true;
      restoreComposerFocusRef.current = false;
    });
  }, []);

  useEffect(() => {
    if (!composerAvailable) return;
    if (hasAutoFocusedComposerRef.current && !restoreComposerFocusRef.current) return;
    const frame = focusComposer();
    return () => window.cancelAnimationFrame(frame);
  }, [composerAvailable, focusComposer]);

  function handleWorkspacePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!pending || !restoreComposerFocusRef.current) return;
    if (composerFormRef.current?.contains(event.target as Node)) return;
    restoreComposerFocusRef.current = false;
  }

  function handleFullscreenEntered() {
    restoreComposerFocusRef.current = true;
    if (!profileOpen && !loading && !pending && canChat) focusComposer();
  }

  useEffect(() => {
    const onStorageError = () => setStorageError(true);
    window.addEventListener("edulab-storage-error", onStorageError);
    return () => window.removeEventListener("edulab-storage-error", onStorageError);
  }, []);

  useEffect(() => {
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      if (activeSessionRef.current?.status !== "active" || messageLedgerRef.current.length === 0) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function uploadBeforeLeaving() {
      if (activeSessionRef.current?.status !== "active" || messageLedgerRef.current.length === 0 || sendingRef.current) return;
      const body = transcriptUploadBody(messageLedgerRef.current);
      // A full transcript above this size cannot fit the unload queue.
      if (new Blob([body]).size > 48_000) return;
      const accepted = navigator.sendBeacon(apiUrl("/api/sessions/checkpoint"), new Blob([body], { type: "application/json" }));
      if (!accepted) {
        void fetch(apiUrl("/api/sessions/checkpoint"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => undefined);
      }
    }
    window.addEventListener("beforeunload", warnBeforeLeaving);
    window.addEventListener("pagehide", uploadBeforeLeaving);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeLeaving);
      window.removeEventListener("pagehide", uploadBeforeLeaving);
    };
  }, [apiUrl]);

  useEffect(() => {
    if (!session || session.status !== "active" || pending || uploading || (!timeExpired && !messageLimitReached)) return;
    if (automaticCompletionRef.current === session.id) return;
    automaticCompletionRef.current = session.id;
    uploadRef.current = true;
    setUploading(true);
    void (async () => {
      try {
        if (controls?.databaseMessagesEnabled) await uploadTranscript(session.id, messageLedgerRef.current, entryToken);
        const payload = await readResponse(await fetch(apiUrl("/api/sessions/complete"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: controls?.databaseMessagesEnabled
            ? JSON.stringify({ messages: [], storedMessageCount: messageLedgerRef.current.length })
            : transcriptUploadBody(messageLedgerRef.current),
          signal: AbortSignal.timeout(90000),
        }));
        applyPayload(payload);
        await refreshConversations().catch(() => undefined);
      } catch {
        setError("云端交互记录暂未完成最终整理，本地记录仍已保留，系统将自动重试。");
        window.setTimeout(() => {
          automaticCompletionRef.current = null;
          setFinalizationRetry((value) => value + 1);
        }, 5000 + Math.random() * 5000);
      } finally { uploadRef.current = false; setUploading(false); }
    })();
  }, [applyPayload, controls?.databaseMessagesEnabled, finalizationRetry, messageLimitReached, pending, refreshConversations, session, timeExpired, uploading, apiUrl, entryToken]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const content = text.trim();
    if (sendingRef.current) return;
    if (!content || pending || !canChat || uploadRef.current || participantSwitching) return;
    if (draftSaveRef.current) await draftSaveRef.current;
    updateComposer("");
    await sendWithId(content, crypto.randomUUID());
  }

  async function retryMessage(content: string) {
    let requestId = crypto.randomUUID();
    try {
      const saved = JSON.parse(localStorage.getItem(outboxKey(sessionIdRef.current ?? "")) ?? "null");
      if (saved?.content === content && saved.clientRequestId) requestId = saved.clientRequestId;
    } catch { /* A confirmed failed request can be retried with a new identifier. */ }
    await sendWithId(content, requestId);
  }

  async function resumeExperiment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loginRequestRef.current) return;
    loginRequestRef.current = true;
    setProfileSaving(true);
    setProfileError("");
    let verified = false;
    try {
      const response = await fetch(apiUrl("/api/sessions/resume"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantCode: resumeCode, identity: resumeIdentity, preferLatest:true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? "实验恢复失败，请重试。");
      const payload = await readResponse(await fetch(apiUrl("/api/sessions"), { cache: "no-store" }));
      verified = true;
      applyPayload(payload);
      setProfileOpen(false);
      setResumeIdentity("");
      setError(null);
      await finishLoginInteraction(payload);
    } catch (resumeError) {
      const notice = resumeError instanceof Error ? resumeError.message : "暂时无法恢复，请稍后重试。";
      if (verified) setError(notice); else setProfileError(notice);
    } finally { setProfileSaving(false); loginRequestRef.current = false; }
  }

  async function retryLoginInteraction() {
    if (conversationBusy) return;
    try {
      const payload = await readResponse(await fetch(apiUrl("/api/sessions"),{cache:"no-store"}));
      applyPayload(payload);
      await finishLoginInteraction(payload);
    } catch (startError) { setError(startError instanceof Error ? startError.message : "暂时无法开启新交互，请重试。"); }
  }

  async function copyParticipantCode() {
    if (!session) return;
    try { await navigator.clipboard.writeText(session.participantCode); setCopyStatus("已复制"); }
    catch { setCopyStatus("复制失败，请手动保存编号"); }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  function openParticipantProfile() {
    setProfileFullName(participantProfile?.fullName ?? "");
    setProfileStudentNumber(participantProfile?.studentNumber ?? "");
    setProfileError("");
    setProfileOpen(true);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profileFullName.trim()) {
      setProfileError("请填写姓名，学号可以不填。");
      return;
    }
    setProfileSaving(true);
    setProfileError("");
    try {
      const registrationKey = `edulab_registration:${entryToken ?? experimentId}`;
      if (!session && !registrationRequestRef.current) {
        let requestId: string | null = null;
        try { requestId = localStorage.getItem(registrationKey); } catch { /* The in-memory retry ID still prevents double clicks. */ }
        registrationRequestRef.current = requestId && /^[0-9a-f-]{36}$/i.test(requestId) ? requestId : crypto.randomUUID();
        try { localStorage.setItem(registrationKey,registrationRequestRef.current); } catch { setStorageError(true); }
      }
      const response = await fetch(apiUrl(session ? "/api/participant-profile" : "/api/sessions"), {
        method: session ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(session
          ? { fullName: profileFullName, studentNumber: profileStudentNumber,revision:participantProfile?.revision ?? 0 }
          : { profile: { fullName: profileFullName, studentNumber: profileStudentNumber },registrationRequestId:registrationRequestRef.current,
            ...(rosterClasses ? {rosterClass} : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new ClientApiError(response.status, data?.error?.code ?? "REQUEST_FAILED", data?.error?.message ?? "参与者信息保存失败。");
      if (session) {
        setParticipantProfile(data.profile as ParticipantProfile);
      } else {
        applyPayload(data as SessionPayload);
        registrationRequestRef.current = null;
        try { localStorage.removeItem(registrationKey); } catch { /* The server record has committed. */ }
        setCodeNoticeOpen(true);
        await refreshConversations().catch(() => setError("身份已创建，但交互列表暂时加载失败，请刷新后继续。"));
      }
      setProfileOpen(false);
    } catch (profileSaveError) {
      if (isInvalidSessionError(profileSaveError)) {
        await releaseInvalidatedSession();
        return;
      }
      setProfileError(profileSaveError instanceof Error ? profileSaveError.message : "参与者信息保存失败。");
    } finally { setProfileSaving(false); }
  }

  async function startNewInteraction(confirmed = false) {
    if (!session || pending || conversationBusy || loginStartPending) return;
    const key = interactionStartKey(entryToken ?? experimentId,session.participantCode);
    let action: InteractionStartAction | null = readInteractionStart(localStorage,key);
    if (!action) {
      if (!confirmed) { setNewInteractionOpen(true); return; }
      action={action:"start_interaction",clientRequestId:crypto.randomUUID(),expectedSessionId:session.id};
      try { localStorage.setItem(key,JSON.stringify(action)); } catch { setStorageError(true); }
    }
    setNewInteractionOpen(false);
    await changeConversation(action);
  }

  async function changeConversation(action: { action: "create" } | { action: "switch"; sessionId: string }
    | {action:"start_interaction";clientRequestId:string;expectedSessionId:string}) {
    if (pending || conversationBusy || (loginStartPending && action.action !== "switch") || uploadRef.current || (action.action === "switch" && action.sessionId === session?.id)) return;
    setUploadStatus("");
    setConversationBusy(true);
    setError(null);
    try {
      if (controls?.databaseMessagesEnabled && session?.status === "active") {
        await saveDraft();
        if (draftRef.current.text !== draftRef.current.savedText) throw new Error("当前草稿尚未保存，请核对草稿提示后再切换对话。");
      }
      const data = await requestConversationChange(action);
      applyPayload(data.payload);
      if (action.action==="start_interaction" && session) {
        try { localStorage.removeItem(interactionStartKey(entryToken ?? experimentId,session.participantCode)); } catch { /* The committed request remains idempotent. */ }
      }
      setConversations(data.conversations as ConversationSummary[]);
      setTaskOpen(false);
    } catch (conversationError) {
      if (isInvalidSessionError(conversationError)) {
        await releaseInvalidatedSession();
        return;
      }
      if (action.action === "start_interaction" && session && conversationError instanceof ClientApiError
        && ["SESSION_CHANGED", "NEWER_INTERACTION_EXISTS"].includes(conversationError.code)) {
        try { localStorage.removeItem(interactionStartKey(entryToken ?? experimentId,session.participantCode)); } catch { /* Retry after selecting the latest interaction. */ }
        await refreshConversations().catch(() => undefined);
      }
      setError(conversationError instanceof Error ? conversationError.message : "暂时无法切换对话。");
    } finally { setConversationBusy(false); }
  }

  async function submitRecords() {
    if (!session || pending || conversationBusy || participantSwitching || uploadRef.current) return;
    uploadRef.current = true;
    setUploading(true); setUploadStatus("正在提交…"); setDownloadStatus("");
    try {
      await uploadAllRecords();
      setUploadStatus("交互记录已提交");
    } catch (uploadError) {
      setUploadStatus(uploadError instanceof Error ? uploadError.message : "提交失败，请重试或下载交互记录。");
    } finally { uploadRef.current = false; setUploading(false); }
  }

  async function uploadAllRecords() {
    if (!session || !controls?.databaseMessagesEnabled) return;
    const ids = new Set([session.id, ...conversations.map(item => item.id)]);
    for (const id of ids) await uploadTranscript(id, id === session.id ? messageLedgerRef.current : readLocalTranscript(id), entryToken);
  }

  async function exportTranscript() {
    if (!session || downloading) return;
    const source = session;
    setDownloading(true); setDownloadStatus("");
    try {
      const response = await fetch(apiUrl("/api/conversations/export"),{cache:"no-store",signal:AbortSignal.timeout(60000)});
      const data = await response.json().catch(()=>null);
      if (!response.ok || !data) throw new ClientApiError(response.ok ? 502 : response.status,data?.error?.code ?? "EXPORT_FAILED",data?.error?.message ?? "全部记录读取失败。");
      const archive = data as ParticipantTranscriptArchive;
      if (archive.participant.code !== source.participantCode || archive.experimentId !== experimentId
        || archive.experimentRunId !== source.experimentRunId || activeSessionRef.current?.participantCode !== source.participantCode) {
        throw new ClientApiError(409,"SESSION_CHANGED","参与者或分组已改变，请在当前窗口重新下载。");
      }
      const record = includeBrowserTranscriptBackups(archive,experiment,id=>id===sessionIdRef.current ? messageLedgerRef.current : readLocalTranscript(id));
      const stamp = record.exportedAt.replaceAll(":","-").replace(".","-");
      downloadFile(`EduLab_${safeExportSegment(source.participantCode,"participant")}_全部交互_${stamp}.json`,JSON.stringify(record,null,2),"application/json;charset=utf-8");
      setDownloadStatus(`已下载 ${record.integrity.sessionCount} 个会话、${record.integrity.messageCount} 条消息。${record.integrity.possiblyIncompleteSessionCount ? "部分会话仍有未确认结果或仅保存在本机，文件中已标注。" : ""}`);
    } catch (downloadError) {
      if (isInvalidSessionError(downloadError)) { await releaseInvalidatedSession(); return; }
      if (activeSessionRef.current?.participantCode !== source.participantCode) return;
      if (downloadError instanceof ClientApiError && downloadError.status < 500) {
        setDownloadStatus(downloadError.message);
      } else {
        exportParticipantArchive();
        setDownloadStatus("未能读取数据库，已下载本机备份，可能缺少其他设备的历史会话。联网后请重新下载全部记录。");
      }
    } finally { setDownloading(false); }
  }

  function exportParticipantArchive() {
    if (!session) return;
    const exportedAt = new Date().toISOString();
    const summaries = conversations.length > 0 ? conversations : [{
      id: session.id,
      title: "当前对话",
      status: session.status,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
    }];
    const record = {
      schemaVersion: 1,
      type: "participant-browser-archive",
      source: "browser",
      allConversationsVerified: false,
      exportedAt,
      participant: { code: session.participantCode },
      experiment: { id: experiment.id, label: experiment.label, title: experiment.title },
      conversations: summaries.map((summary) => {
        const transcript = summary.id === session.id ? messageLedgerRef.current : readLocalTranscript(summary.id);
        return {
          session: summary,
          integrity: {
            messageCount: transcript.length,
            turnCount: new Set(transcript.map((message) => message.turnIndex)).size,
          },
          messages: transcript.map((message, index) => ({
            order: index + 1,
            sequenceNo: message.sequenceNo,
            turnIndex: message.turnIndex,
            role: message.role,
            content: message.content,
            sentAt: message.sentAt,
            replyStartedAt: message.replyStartedAt,
            replyCompletedAt: message.replyCompletedAt,
            latencyMs: message.latencyMs,
            clientRequestId: message.clientRequestId,
            cozeMessageId: message.cozeMessageId,
            cozeChatId: message.cozeChatId,
            ...(message.provider === "dify" ? {provider: message.provider, providerMessageId: message.providerMessageId ?? null, providerTaskId: message.providerTaskId ?? null} : {}),
          })),
        };
      }),
    };
    const safeParticipant = session.participantCode.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) || "participant";
    const stamp = exportedAt.replaceAll(":", "-").replace(".", "-");
    downloadFile(`EduLab_${safeParticipant}_本机备份_${stamp}.json`, JSON.stringify(record, null, 2), "application/json;charset=utf-8");
  }

  async function startNextParticipant() {
    if (!session || pending || conversationBusy || participantSwitching || uploadRef.current) return;
    const confirmed = window.confirm("仅在实验人员要求时使用。系统将保存当前参与者的交互记录并退出，然后由下一位参与者填写信息。确认继续吗？");
    if (!confirmed) return;
    uploadRef.current = true;
    setUploading(true);
    setParticipantSwitching(true);
    setProfileError("");
    try {
      if (controls?.databaseMessagesEnabled === false) exportParticipantArchive();
      else await uploadAllRecords();
      const response = await fetch(apiUrl("/api/sessions/reset"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: controls?.databaseMessagesEnabled
          ? JSON.stringify({ messages: [], storedMessageCount: messageLedgerRef.current.length })
          : transcriptUploadBody(messageLedgerRef.current),
      });
      const data = await response.json();
      if (!response.ok) throw new ClientApiError(response.status, data?.error?.code ?? "REQUEST_FAILED", data?.error?.message ?? "暂时无法切换参与者。");

      localStorage.removeItem(outboxKey(session.id));
      localStorage.removeItem(interactionStartKey(entryToken ?? experimentId,session.participantCode));
      setLoginStartPending(false);
      setDownloadStatus("");
      draftRef.current = { sessionId: "", text: "", savedText: "", revision: 0, conflict: false };
      setEntryMode("new");
      setDraftStatus("");
      sessionIdRef.current = null;
      activeSessionRef.current = null;
      messageLedgerRef.current = [];
      automaticCompletionRef.current = null;
      setSession(null);
      setMessages([]);
      setControls(null);
      setConversations([]);
      setParticipantProfile(null);
      setCodeNoticeOpen(false);
      setNewInteractionOpen(false);
      setProfileFullName("");
      setProfileStudentNumber("");
      setText("");
      setRetryContent(null);
      setError(null);
      setTaskOpen(false);
      setProfileOpen(true);
      hasAutoFocusedComposerRef.current = false;
      restoreComposerFocusRef.current = false;
      window.history.replaceState({}, "", window.location.pathname);
    } catch (switchError) {
      if (isInvalidSessionError(switchError)) {
        clearInvalidatedSession("原参与者记录已从后台删除，请填写下一位参与者信息。");
        return;
      }
      setProfileError(switchError instanceof Error ? switchError.message : "暂时无法切换参与者。");
    } finally {
      setParticipantSwitching(false);
      uploadRef.current = false;
      setUploading(false);
    }
  }

  const participantCodeDetails = session && participantProfile && <div className="participant-code-details">
    <p>你的被试编号</p><strong>{session.participantCode}</strong>
    <p className="participant-code-hint">{controls?.databaseMessagesEnabled ? "继续实验时，请输入此编号和姓名或学号。" : "本实验未启用云端保存，请及时下载记录。"}</p>
    <div className="participant-code-actions"><button type="button" className="participant-code-copy" onClick={copyParticipantCode}>复制编号</button><span role="status">{copyStatus}</span></div>
  </div>;

  return (
    <main className="app-shell" onPointerDownCapture={handleWorkspacePointerDown}>
      <FullscreenController fullscreenState={fullscreenState} onEntered={handleFullscreenEntered} />
      <section className={`workspace conversation-workspace ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} aria-label="AI 对话工作区">
        <aside className="conversation-sidebar" aria-label="对话列表">
          <div className="conversation-sidebar-head">
            <div className="brand sidebar-brand"><button className="brand-mark brand-toggle" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"} title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}><BrandLogo size={32} /></button>{!sidebarCollapsed && <div className="brand-name">EduLab</div>}</div>
          </div>
          <button className="new-conversation" onClick={() => void startNewInteraction()} disabled={loading || pending || conversationBusy || loginStartPending || !session || !participantProfile}><span>＋</span>{!sidebarCollapsed && <em>开始新一次交互</em>}</button>
          <nav className="conversation-list">
            {conversations.map((conversation) => <button key={conversation.id} className={conversation.id === session?.id ? "conversation-item active" : "conversation-item"} onClick={() => changeConversation({ action: "switch", sessionId: conversation.id })} disabled={pending || conversationBusy} title={`${conversation.title} · ${new Date(conversation.startedAt).toLocaleString("zh-CN")} · ${conversation.id}`}><span className="conversation-icon">{conversation.title.slice(0, 1)}</span>{!sidebarCollapsed && <span className="conversation-copy"><strong>{conversation.title}</strong><small>{conversation.status === "completed" ? "已结束 · " + new Date(conversation.startedAt).toLocaleDateString("zh-CN") : "继续 · " + new Date(conversation.startedAt).toLocaleDateString("zh-CN") + " " + timeLabel(conversation.startedAt)}</small></span>}</button>)}
          </nav>
          <button className={`participant-profile-button ${participantProfile ? "complete" : "required"}`} onClick={openParticipantProfile} title="填写或修改基本信息"><span className="participant-profile-icon" aria-hidden="true">S</span>{!sidebarCollapsed && <span className="participant-profile-copy"><strong>{participantProfile?.fullName || participantProfile?.studentNumber || "待填写"}</strong>{participantProfile?.fullName && participantProfile.studentNumber && <small>{participantProfile.studentNumber}</small>}</span>}</button>
        </aside>
        <section className="chat-panel" aria-label="AI 对话">
          <header className="chat-header">
            <div className="assistant-title"><div className="assistant-avatar" aria-hidden="true">AI</div><div><p className="assistant-name">{experiment.assistantName}</p><p className="assistant-status">{!participantProfile && session ? "请先填写参与者信息" : session?.status === "completed" || timeExpired || messageLimitReached ? "本次对话已结束" : pending ? "正在思考…" : limitText || "在线"}</p></div></div>
            <div className="session-actions">
              {experiment.taskVisible && <button className="task-toggle-button" onClick={() => setTaskOpen((value) => !value)}>{taskOpen ? "关闭说明" : "任务说明"}</button>}
              <div className="export-actions"><button onClick={() => void exportTranscript()} disabled={!session || loading || conversationBusy || downloading}>{downloading ? "正在整理…" : "下载全部交互记录"}</button>{controls?.databaseMessagesEnabled && <button onClick={() => void submitRecords()} disabled={!session || pending || uploading || messages.length === 0}>{uploading ? "提交中…" : "提交交互记录"}</button>}<span role="status">{downloadStatus || uploadStatus}</span></div>
            </div>
          </header>
          <div className="messages" ref={messagesViewRef} aria-live="polite">
            {taskOpen && experiment.taskVisible && <section className="inline-task-panel"><div className="inline-task-head"><div><small>任务说明</small><h2>{experiment.title}</h2></div><button onClick={() => setTaskOpen(false)} aria-label="关闭任务说明">×</button></div><p>{experiment.introduction}</p><ol>{experiment.requirements.map((item) => <li key={item}>{item}</li>)}</ol>{experiment.material && <div><strong>学习材料</strong><p>{experiment.material}</p></div>}{experiment.hint && <div><strong>提示</strong><p>{experiment.hint}</p></div>}</section>}
            <p className="day-label">{session ? `开始于 ${timeLabel(session.startedAt)}` : "新对话"}</p>
            {messages.length === 0 && !loading && <div className="conversation-welcome" role="note"><p className="welcome-title">你好，我是{experiment.assistantName}。</p><p className="welcome-copy">{experiment.welcome}</p></div>}
            {messages.map((message) => <div className={`message-row ${message.role}`} key={message.id}><div className="message-stack"><div className="bubble"><MessageBody message={message} /></div><div className={`message-time ${message.role}`}>{timeLabel(message.sentAt)}</div></div></div>)}
            {pending && (streamingReply
              ? <div className="message-row assistant"><div className="message-stack"><div className="bubble"><MessageBody message={{ role: "assistant", content: streamingReply }} /></div></div></div>
              : <div className="message-row assistant"><div className="bubble typing" aria-label="AI 正在回复"><span /><span /><span /></div></div>)}
            {storageError && <div className="error-card" role="alert">本机保存空间不可用，请先下载交互记录并联系实验人员，暂勿刷新或关闭页面。</div>}
            {error && <div className="error-card" role="alert"><span>{error}</span>{loginStartPending ? <button onClick={() => void retryLoginInteraction()} disabled={conversationBusy}>重试开启新交互</button> : retryContent && <button onClick={() => retryMessage(retryContent)} disabled={pending}>重新发送</button>}</div>}
            {conversationBusy && loginStartPending && <div className="loading-note" role="status">正在保存上次记录并开启新交互…</div>}
            {loading && <div className="loading-note">正在准备实验会话…</div>}
            {session?.status === "completed" && <div className="completed-card">这个对话已经结束。你可以在左侧查看其他对话。</div>}
          </div>
          <div className="composer-wrap">
            <form className="composer" onSubmit={submit} ref={composerFormRef}>
              <textarea ref={composerInputRef} aria-label="输入消息" placeholder={!participantProfile && session ? "请先填写参与者信息" : !canChat && !loading ? "本次交流已结束" : "输入你的问题或想法…"} rows={1} value={text} maxLength={controls?.maxMessageChars} onChange={(event) => updateComposer(event.target.value)} onKeyDown={onComposerKeyDown} disabled={loading || pending || !canChat} />
              <button className="send-button" type="submit" disabled={!text.trim() || loading || pending || !canChat} aria-label="发送消息">↑</button>
            </form>
            <p className="composer-help"><span>按 Enter 发送 · Shift + Enter 换行</span>{controls && <span>{Array.from(text).length} / {controls.maxMessageChars} 字</span>}</p>
            {draftStatus && <p className="draft-status" role="status">{draftStatus}</p>}
            {draftConflict && session && <div className="draft-conflict-actions"><button type="button" onClick={() => resolveDraftConflict(true)} disabled={pending}>保存当前草稿</button><button type="button" onClick={() => resolveDraftConflict(false)} disabled={pending}>使用云端草稿</button></div>}
          </div>
        </section>
      </section>
      {codeNoticeOpen && <div className="profile-modal-backdrop">
        <section className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="code-notice-title">
          <div className="profile-modal-head"><h2 id="code-notice-title">请保存被试编号</h2><button type="button" onClick={() => setCodeNoticeOpen(false)} aria-label="关闭编号提醒">×</button></div>
          {participantCodeDetails}
          <p className="participant-code-location">编号也可在左下角参与者信息中查看。</p>
          <div className="profile-modal-actions"><button type="button" className="profile-save" onClick={() => setCodeNoticeOpen(false)}>已记下，开始交互</button></div>
        </section>
      </div>}
      {newInteractionOpen && <div className="profile-modal-backdrop"><section className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="new-interaction-title"><div className="profile-modal-head"><h2 id="new-interaction-title">开始新的学习任务？</h2><button type="button" onClick={()=>setNewInteractionOpen(false)} aria-label="取消新交互">×</button></div><p className="profile-hint">系统会保存并结束当前这次交互，创建独立会话。你的编号、原分组和历史记录保持不变，未发送的草稿保留在原会话中。</p><button type="button" className="profile-save" onClick={()=>void startNewInteraction(true)}>确认开始新一次交互</button></section></div>}
      {profileOpen && <div className="profile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && participantProfile) setProfileOpen(false); }}>
        <section className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
          <div className="profile-modal-head"><div><p>参与者信息</p><h2 id="profile-title">{participantProfile ? "查看或修改基本信息" : !session && entryMode === "resume" ? "继续之前的实验" : "开始前请填写基本信息"}</h2></div>{participantProfile && <button type="button" onClick={() => setProfileOpen(false)} aria-label="关闭">×</button>}</div>
          {participantCodeDetails}
          {!session && <div className="entry-tabs" role="group" aria-label="实验入口"><button type="button" aria-pressed={entryMode === "new"} onClick={() => { setEntryMode("new"); setProfileError(""); }} disabled={profileSaving}>首次参加实验</button><button type="button" aria-pressed={entryMode === "resume"} onClick={() => { setEntryMode("resume"); setProfileError(""); }} disabled={profileSaving}>继续之前的实验</button></div>}
          {!session && entryMode === "resume" ? <form className="profile-form" onSubmit={resumeExperiment}>
            <label><span>实验编号</span><input value={resumeCode} onChange={(event) => setResumeCode(event.target.value)} maxLength={80} autoComplete="off" placeholder="例如 P001" required /></label>
            <label><span>身份校验</span><input value={resumeIdentity} onChange={(event) => setResumeIdentity(event.target.value)} type="password" maxLength={100} autoComplete="off" placeholder="当前姓名或学号" required /></label>
            <p className="profile-hint">使用原编号及当前姓名或学号登录后，将自动开启新一次交互，保留原分组和历史记录。刷新页面或断线重连会继续当前会话。</p>
            {profileError && <p className="profile-error" role="alert">{profileError}</p>}
            <button className="profile-save" type="submit" disabled={profileSaving}>{profileSaving ? "正在进入…" : "登录并开始"}</button>
          </form> : <form className="profile-form" onSubmit={saveProfile}>
            {rosterClasses && !session && <label><span>班级</span><select value={rosterClass} onChange={event=>setRosterClass(event.target.value)} required><option value="">请选择班级</option>{rosterClasses.map(name=><option key={name} value={name}>{name}</option>)}</select></label>}
            <label><span>姓名</span><input value={profileFullName} onChange={(event) => setProfileFullName(event.target.value)} maxLength={100} autoComplete="name" placeholder="请输入姓名" required /></label>
            {!rosterClasses && <label><span>学号</span><input value={profileStudentNumber} onChange={(event) => setProfileStudentNumber(event.target.value)} maxLength={100} autoComplete="off" placeholder="学号选填" /></label>}
            <p className="profile-hint">{rosterClasses ? "请准确填写教师名单中的参与姓名，包括用于区分重名的数字。已有编号请使用继续之前的实验；匹配不到请联系教师。" : "姓名必填，允许重名；学号选填。有原编号请使用“继续之前的实验”，不要重复首次报名。"}</p>
            {profileError && <p className="profile-error" role="alert">{profileError}</p>}
            <button className="profile-save" type="submit" disabled={profileSaving || participantSwitching}>{profileSaving ? "保存中…" : participantProfile ? "保存修改" : "保存并开始"}</button>
            {participantProfile && <div className="next-participant"><button type="button" onClick={startNextParticipant} disabled={pending || profileSaving || participantSwitching}>{participantSwitching ? "正在保存并切换…" : "开始下一位参与者"}</button><p>仅在实验人员要求时使用。切换后当前参与者将无法在此浏览器继续操作。</p></div>}
          </form>}
        </section>
      </div>}
    </main>
  );
}
