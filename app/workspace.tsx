"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StoredMessage } from "@/db/schema";
import type { ExperimentConfig } from "@/config/experiment";
import type { ParticipantProfile, SessionPayload } from "@/lib/client-types";
import { buildTranscriptExport, safeExportSegment } from "@/lib/transcript-export";

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

function writeLocalTranscript(activeSession: SessionPayload["session"], messages: StoredMessage[]) {
  try {
    localStorage.setItem(transcriptKey(activeSession.id), JSON.stringify({
      version: 2,
      sessionId: activeSession.id,
      participantCode: activeSession.participantCode,
      updatedAt: new Date().toISOString(),
      messages,
    }));
  } catch { /* The in-memory ledger and export remain available if browser storage is unavailable. */ }
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
  const data = await response.json();
  if (!response.ok) throw new ClientApiError(response.status, data?.error?.code ?? "REQUEST_FAILED", data?.error?.message ?? "请求失败，请稍后重试。");
  return data;
}

class ClientApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function isInvalidSessionError(error: unknown) {
  return error instanceof ClientApiError && error.status === 401 && error.code === "SESSION_REQUIRED";
}

function clearLocalParticipantData(participantCode: string, currentSessionId: string | null) {
  const sessionIds = new Set<string>(currentSessionId ? [currentSessionId] : []);
  const transcriptKeys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(TRANSCRIPT_PREFIX)) continue;
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "{}") as { participantCode?: string; sessionId?: string };
      if (saved.participantCode !== participantCode) continue;
      transcriptKeys.push(key);
      if (saved.sessionId) sessionIds.add(saved.sessionId);
    } catch { /* Ignore unrelated or malformed browser data. */ }
  }
  for (const key of transcriptKeys) localStorage.removeItem(key);
  for (const sessionId of sessionIds) localStorage.removeItem(outboxKey(sessionId));
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function MessageBody({ message }: { message: StoredMessage }) {
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

export function ExperimentWorkspace({ experiment }: { experiment: ExperimentConfig }) {
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [session, setSession] = useState<SessionPayload["session"] | null>(null);
  const [controls, setControls] = useState<SessionPayload["controls"] | null>(null);
  const [clock, setClock] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryContent, setRetryContent] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [conversationBusy, setConversationBusy] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [participantProfile, setParticipantProfile] = useState<ParticipantProfile | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileFullName, setProfileFullName] = useState("");
  const [profileStudentNumber, setProfileStudentNumber] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [participantSwitching, setParticipantSwitching] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [finalizationRetry, setFinalizationRetry] = useState(0);
  const messagesViewRef = useRef<HTMLDivElement>(null);
  const messageLedgerRef = useRef<StoredMessage[]>([]);
  const activeSessionRef = useRef<SessionPayload["session"] | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const automaticCompletionRef = useRef<string | null>(null);

  const clearInvalidatedSession = useCallback((notice: string) => {
    const previousSession = activeSessionRef.current;
    if (previousSession) clearLocalParticipantData(previousSession.participantCode, previousSession.id);
    sessionIdRef.current = null;
    activeSessionRef.current = null;
    messageLedgerRef.current = [];
    automaticCompletionRef.current = null;
    setSession(null);
    setMessages([]);
    setControls(null);
    setConversations([]);
    setParticipantProfile(null);
    setProfileFullName("");
    setProfileStudentNumber("");
    setText("");
    setPending(false);
    setRetryContent(null);
    setError(null);
    setTaskOpen(false);
    setProfileError(notice);
    setProfileOpen(true);
    setLoading(false);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const releaseInvalidatedSession = useCallback(async (notice = "原参与者记录已从后台删除，请填写下一位参与者信息。") => {
    const transcript = transcriptUploadBody(messageLedgerRef.current);
    clearInvalidatedSession(notice);
    try {
      await fetch("/api/sessions/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: transcript,
      });
    } catch { /* Local cleanup must still continue when the deleted server record is unavailable. */ }
  }, [clearInvalidatedSession]);

  const applyPayload = useCallback((payload: SessionPayload) => {
    const changedSession = sessionIdRef.current !== null && sessionIdRef.current !== payload.session.id;
    sessionIdRef.current = payload.session.id;
    activeSessionRef.current = payload.session;
    setSession(payload.session);
    setParticipantProfile(payload.participantProfile);
    if (!payload.participantProfile) setProfileOpen(true);
    const localMessages = readLocalTranscript(payload.session.id);
    const mergedMessages = mergeMessages(localMessages, changedSession ? [] : messageLedgerRef.current, payload.messages);
    messageLedgerRef.current = mergedMessages;
    setMessages(mergedMessages);
    writeLocalTranscript(payload.session, mergedMessages);
    setPending(payload.pending);
    setControls(payload.controls);
    if (payload.failedRequest) {
      setError(payload.failedRequest.message);
      setRetryContent(payload.failedRequest.content);
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
  }, []);

  const refreshConversations = useCallback(async () => {
    const response = await fetch("/api/conversations", { cache: "no-store" });
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
  }, [releaseInvalidatedSession]);

  const pollUntilSettled = useCallback(async () => {
    const expectedSessionId = sessionIdRef.current;
    if (!expectedSessionId) return;
    for (let attempt = 0; attempt < 45; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (sessionIdRef.current !== expectedSessionId) return;
      const response = await fetch("/api/sessions", { cache: "no-store" });
      const payload = await readResponse(response);
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
  }, [applyPayload, releaseInvalidatedSession]);

  const sendWithId = useCallback(async (content: string, clientRequestId: string) => {
    setError(null);
    setRetryContent(null);
    setPending(true);
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) return;
    const turnIndex = Math.max(0, ...messageLedgerRef.current.map((message) => message.turnIndex ?? 0)) + 1;
    const userSequence = Math.max(0, ...messageLedgerRef.current.filter((message) => message.sequenceNo < Number.MAX_SAFE_INTEGER).map((message) => message.sequenceNo)) + 1;
    localStorage.setItem(outboxKey(activeSessionId), JSON.stringify({ content, clientRequestId }));
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
      if (activeSessionRef.current) writeLocalTranscript(activeSessionRef.current, nextMessages);
    }
    try {
      const response = await fetch("/api/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, clientRequestId, turnIndex, userSequence }),
      });
      const payload = await readResponse(response);
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
        const recovered = await readResponse(await fetch("/api/sessions", { cache: "no-store" }));
        applyPayload(recovered);
        if (recovered.pending) await pollUntilSettled();
      } catch { /* Keep the saved outbox for a later retry. */ }
    }
  }, [applyPayload, pollUntilSettled, releaseInvalidatedSession]);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      const params = new URLSearchParams(window.location.search);
      const participantCode = params.get("participant");
      const access = params.get("access") ?? undefined;
      if (!participantCode) {
        try {
          const response = await fetch("/api/sessions", { cache: "no-store" });
          if (response.status === 401) {
            if (!cancelled) setProfileOpen(true);
            return;
          }
          const payload = await readResponse(response);
          if (!cancelled) {
            applyPayload(payload);
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
        const payload = await readResponse(await fetch("/api/sessions", {
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
            await sendWithId(saved.content, saved.clientRequestId);
          }
        }
      } catch (initialError) {
        if (!cancelled) setError(initialError instanceof Error ? initialError.message : "无法进入实验，请检查链接。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialize();
    return () => { cancelled = true; };
  }, [applyPayload, pollUntilSettled, refreshConversations, sendWithId]);

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
    channel.onmessage = (event: MessageEvent<{ type?: string; participantCode?: string }>) => {
      if (event.data?.type === "participant_deleted" && event.data.participantCode === activeSessionRef.current?.participantCode) {
        void releaseInvalidatedSession();
      }
    };
    return () => channel.close();
  }, [releaseInvalidatedSession]);

  useEffect(() => {
    const container = messagesViewRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);
  useEffect(() => {
    if (!controls?.endsAt || session?.status !== "active") return;
    const initial = window.setTimeout(() => setClock(Date.now()), 0);
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [controls?.endsAt, session?.status]);

  const remainingSeconds = controls?.endsAt && clock > 0 ? Math.max(0, Math.ceil((new Date(controls.endsAt).getTime() - clock) / 1000)) : null;
  const timeExpired = remainingSeconds === 0;
  const messageLimitReached = controls?.remainingMessages === 0;
  const canChat = Boolean(participantProfile && session?.status === "active" && controls?.chatEnabled && !timeExpired && !messageLimitReached);
  const limitText = [
    controls?.remainingMessages === null || controls?.remainingMessages === undefined ? null : `剩余 ${controls.remainingMessages} 次`,
    remainingSeconds === null ? null : `剩余 ${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`,
  ].filter(Boolean).join(" · ");

  useEffect(() => {
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      if (activeSessionRef.current?.status !== "active" || messageLedgerRef.current.length === 0) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function uploadBeforeLeaving() {
      if (activeSessionRef.current?.status !== "active" || messageLedgerRef.current.length === 0) return;
      const body = transcriptUploadBody(messageLedgerRef.current);
      const accepted = navigator.sendBeacon("/api/sessions/checkpoint", new Blob([body], { type: "application/json" }));
      if (!accepted) {
        void fetch("/api/sessions/checkpoint", {
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
  }, []);

  useEffect(() => {
    if (!session || session.status !== "active" || pending || (!timeExpired && !messageLimitReached)) return;
    if (automaticCompletionRef.current === session.id) return;
    automaticCompletionRef.current = session.id;
    void (async () => {
      try {
        const payload = await readResponse(await fetch("/api/sessions/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: transcriptUploadBody(messageLedgerRef.current),
        }));
        applyPayload(payload);
        await refreshConversations().catch(() => undefined);
      } catch {
        automaticCompletionRef.current = null;
        setError("云端交互记录暂未完成最终整理，本地记录仍已保留，系统将自动重试。");
        window.setTimeout(() => setFinalizationRetry((value) => value + 1), 5000);
      }
    })();
  }, [applyPayload, finalizationRetry, messageLimitReached, pending, refreshConversations, session, timeExpired]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const content = text.trim();
    if (!content || pending || !canChat) return;
    setText("");
    await sendWithId(content, crypto.randomUUID());
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
    if (!profileFullName.trim() && !profileStudentNumber.trim()) {
      setProfileError("请至少填写姓名或学号中的一项。");
      return;
    }
    setProfileSaving(true);
    setProfileError("");
    try {
      const response = await fetch(session ? "/api/participant-profile" : "/api/sessions", {
        method: session ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(session
          ? { fullName: profileFullName, studentNumber: profileStudentNumber }
          : { profile: { fullName: profileFullName, studentNumber: profileStudentNumber } }),
      });
      const data = await response.json();
      if (!response.ok) throw new ClientApiError(response.status, data?.error?.code ?? "REQUEST_FAILED", data?.error?.message ?? "参与者信息保存失败。");
      if (session) {
        setParticipantProfile(data.profile as ParticipantProfile);
      } else {
        applyPayload(data as SessionPayload);
        await refreshConversations();
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

  async function changeConversation(action: { action: "create" } | { action: "switch"; sessionId: string }) {
    if (pending || conversationBusy || (action.action === "switch" && action.sessionId === session?.id)) return;
    setConversationBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/conversations", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action),
      });
      const data = await response.json();
      if (!response.ok) throw new ClientApiError(response.status, data?.error?.code ?? "REQUEST_FAILED", data?.error?.message ?? "暂时无法切换对话。");
      applyPayload(data.payload as SessionPayload);
      setConversations(data.conversations as ConversationSummary[]);
      setTaskOpen(false);
    } catch (conversationError) {
      if (isInvalidSessionError(conversationError)) {
        await releaseInvalidatedSession();
        return;
      }
      setError(conversationError instanceof Error ? conversationError.message : "暂时无法切换对话。");
    } finally { setConversationBusy(false); }
  }

  function exportTranscript() {
    if (!session) return;
    const transcript = messageLedgerRef.current;
    const exportedAt = new Date().toISOString();
    const record = buildTranscriptExport({
      exportedAt,
      session,
      experiment,
      databaseMessagesEnabled: controls?.databaseMessagesEnabled ?? true,
      browserBackupIncluded: true,
      messages: transcript,
    });
    const safeParticipant = safeExportSegment(session.participantCode, "participant");
    const stamp = exportedAt.replaceAll(":", "-").replace(".", "-");
    downloadFile(`EduLab_${safeParticipant}_${stamp}.json`, JSON.stringify(record, null, 2), "application/json;charset=utf-8");
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
          })),
        };
      }),
    };
    const safeParticipant = session.participantCode.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) || "participant";
    const stamp = exportedAt.replaceAll(":", "-").replace(".", "-");
    downloadFile(`EduLab_${safeParticipant}_全部对话_${stamp}.json`, JSON.stringify(record, null, 2), "application/json;charset=utf-8");
  }

  async function startNextParticipant() {
    if (!session || pending || participantSwitching) return;
    const confirmed = window.confirm("仅在实验人员要求时使用。系统将保存当前参与者的交互记录并退出，然后由下一位参与者填写信息。确认继续吗？");
    if (!confirmed) return;
    setParticipantSwitching(true);
    setProfileError("");
    try {
      if (controls?.databaseMessagesEnabled === false) exportParticipantArchive();
      const response = await fetch("/api/sessions/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: transcriptUploadBody(messageLedgerRef.current),
      });
      const data = await response.json();
      if (!response.ok) throw new ClientApiError(response.status, data?.error?.code ?? "REQUEST_FAILED", data?.error?.message ?? "暂时无法切换参与者。");

      localStorage.removeItem(outboxKey(session.id));
      sessionIdRef.current = null;
      activeSessionRef.current = null;
      messageLedgerRef.current = [];
      automaticCompletionRef.current = null;
      setSession(null);
      setMessages([]);
      setControls(null);
      setConversations([]);
      setParticipantProfile(null);
      setProfileFullName("");
      setProfileStudentNumber("");
      setText("");
      setRetryContent(null);
      setError(null);
      setTaskOpen(false);
      setProfileOpen(true);
      window.history.replaceState({}, "", window.location.pathname);
    } catch (switchError) {
      if (isInvalidSessionError(switchError)) {
        clearInvalidatedSession("原参与者记录已从后台删除，请填写下一位参与者信息。");
        return;
      }
      setProfileError(switchError instanceof Error ? switchError.message : "暂时无法切换参与者。");
    } finally {
      setParticipantSwitching(false);
    }
  }

  return (
    <main className="app-shell">
      <section className={`workspace conversation-workspace ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} aria-label="AI 对话工作区">
        <aside className="conversation-sidebar" aria-label="对话列表">
          <div className="conversation-sidebar-head">
            <div className="brand sidebar-brand"><button className="brand-mark brand-toggle" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"} title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}>E</button>{!sidebarCollapsed && <div className="brand-name">EduLab</div>}</div>
          </div>
          <button className="new-conversation" onClick={() => changeConversation({ action: "create" })} disabled={loading || pending || conversationBusy || !participantProfile}><span>＋</span>{!sidebarCollapsed && <em>新建对话</em>}</button>
          <nav className="conversation-list">
            {conversations.map((conversation) => <button key={conversation.id} className={conversation.id === session?.id ? "conversation-item active" : "conversation-item"} onClick={() => changeConversation({ action: "switch", sessionId: conversation.id })} disabled={pending || conversationBusy} title={conversation.title}><span className="conversation-icon">{conversation.title.slice(0, 1)}</span>{!sidebarCollapsed && <span className="conversation-copy"><strong>{conversation.title}</strong><small>{conversation.status === "completed" ? "已结束" : timeLabel(conversation.lastActivityAt)}</small></span>}</button>)}
          </nav>
          <button className={`participant-profile-button ${participantProfile ? "complete" : "required"}`} onClick={openParticipantProfile} title="填写或修改基本信息"><span className="participant-profile-icon" aria-hidden="true">S</span>{!sidebarCollapsed && <span className="participant-profile-copy"><strong>{participantProfile?.fullName || participantProfile?.studentNumber || "待填写"}</strong>{participantProfile?.fullName && participantProfile.studentNumber && <small>{participantProfile.studentNumber}</small>}</span>}</button>
        </aside>
        <section className="chat-panel" aria-label="AI 对话">
          <header className="chat-header">
            <div className="assistant-title"><div className="assistant-avatar" aria-hidden="true">AI</div><div><p className="assistant-name">{experiment.assistantName}</p><p className="assistant-status">{!participantProfile && session ? "请先填写参与者信息" : session?.status === "completed" || timeExpired || messageLimitReached ? "本次对话已结束" : pending ? "正在思考…" : limitText || "在线"}</p></div></div>
            <div className="session-actions">
              {experiment.taskVisible && <button className="task-toggle-button" onClick={() => setTaskOpen((value) => !value)}>{taskOpen ? "关闭说明" : "任务说明"}</button>}
              <div className="export-actions"><button onClick={exportTranscript} disabled={!session || messages.length === 0}>下载交互记录</button></div>
            </div>
          </header>
          <div className="messages" ref={messagesViewRef} aria-live="polite">
            {taskOpen && experiment.taskVisible && <section className="inline-task-panel"><div className="inline-task-head"><div><small>任务说明</small><h2>{experiment.title}</h2></div><button onClick={() => setTaskOpen(false)} aria-label="关闭任务说明">×</button></div><p>{experiment.introduction}</p><ol>{experiment.requirements.map((item) => <li key={item}>{item}</li>)}</ol>{experiment.material && <div><strong>学习材料</strong><p>{experiment.material}</p></div>}{experiment.hint && <div><strong>提示</strong><p>{experiment.hint}</p></div>}</section>}
            <p className="day-label">{session ? `开始于 ${timeLabel(session.startedAt)}` : "新对话"}</p>
            {messages.length === 0 && !loading && <div className="conversation-welcome" role="note"><p className="welcome-title">你好，我是{experiment.assistantName}。</p><p className="welcome-copy">{experiment.welcome}</p></div>}
            {messages.map((message) => <div className={`message-row ${message.role}`} key={message.id}><div className="message-stack"><div className="bubble"><MessageBody message={message} /></div><div className={`message-time ${message.role}`}>{timeLabel(message.sentAt)}</div></div></div>)}
            {pending && <div className="message-row assistant"><div className="bubble typing" aria-label="AI 正在回复"><span /><span /><span /></div></div>}
            {error && <div className="error-card" role="alert"><span>{error}</span>{retryContent && <button onClick={() => sendWithId(retryContent, crypto.randomUUID())} disabled={pending}>重新发送</button>}</div>}
            {loading && <div className="loading-note">正在准备实验会话…</div>}
            {session?.status === "completed" && <div className="completed-card">这个对话已经结束。你可以在左侧查看其他对话。</div>}
          </div>
          <div className="composer-wrap">
            <form className="composer" onSubmit={submit}>
              <textarea aria-label="输入消息" placeholder={!participantProfile && session ? "请先填写参与者信息" : !canChat && !loading ? "本次交流已结束" : "输入你的问题或想法…"} rows={1} value={text} maxLength={controls?.maxMessageChars} onChange={(event) => setText(event.target.value)} onKeyDown={onComposerKeyDown} disabled={loading || pending || !canChat} />
              <button className="send-button" type="submit" disabled={!text.trim() || loading || pending || !canChat} aria-label="发送消息">↑</button>
            </form>
            <p className="composer-help"><span>按 Enter 发送 · Shift + Enter 换行</span>{controls && <span>{Array.from(text).length} / {controls.maxMessageChars} 字</span>}</p>
          </div>
        </section>
      </section>
      {profileOpen && <div className="profile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && participantProfile) setProfileOpen(false); }}>
        <section className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
          <div className="profile-modal-head"><div><p>参与者信息</p><h2 id="profile-title">{participantProfile ? "查看或修改基本信息" : "开始前请填写基本信息"}</h2></div>{participantProfile && <button type="button" onClick={() => setProfileOpen(false)} aria-label="关闭">×</button>}</div>
          <form className="profile-form" onSubmit={saveProfile}>
            <label><span>姓名</span><input value={profileFullName} onChange={(event) => setProfileFullName(event.target.value)} maxLength={100} autoComplete="name" placeholder="请输入姓名" /></label>
            <label><span>学号</span><input value={profileStudentNumber} onChange={(event) => setProfileStudentNumber(event.target.value)} maxLength={100} autoComplete="off" placeholder="请输入学号" /></label>
            <p className="profile-hint">至少填写一项。请使用研究者要求的信息。</p>
            {profileError && <p className="profile-error" role="alert">{profileError}</p>}
            <button className="profile-save" type="submit" disabled={profileSaving || participantSwitching}>{profileSaving ? "保存中…" : participantProfile ? "保存修改" : "保存并开始"}</button>
            {participantProfile && <div className="next-participant"><button type="button" onClick={startNextParticipant} disabled={pending || profileSaving || participantSwitching}>{participantSwitching ? "正在保存并切换…" : "开始下一位参与者"}</button><p>仅在实验人员要求时使用。切换后当前参与者将无法在此浏览器继续操作。</p></div>}
          </form>
        </section>
      </div>}
    </main>
  );
}
