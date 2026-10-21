import type { ExperimentConfig } from "@/config/experiment";
import type { StoredMessage } from "@/db/schema";

export interface TranscriptExportSession {
  id: string;
  status: "active" | "completed";
  startedAt: string;
  lastActivityAt: string;
  participantCode: string;
  cozeConversationId: string | null;
  provider?: "coze" | "dify";
  difyConversationId?: string | null;
  experimentRunId: string | null;
  agentId: string | null;
}

export function buildTranscriptExport(input: {
  exportedAt: string;
  session: TranscriptExportSession;
  experiment: ExperimentConfig;
  databaseMessagesEnabled: boolean;
  browserBackupIncluded: boolean;
  messages: StoredMessage[];
}) {
  const messages = [...input.messages].sort((left, right) =>
    left.sequenceNo - right.sequenceNo || new Date(left.sentAt).getTime() - new Date(right.sentAt).getTime(),
  );
  return {
    schemaVersion: 2,
    exportedAt: input.exportedAt,
    participant: { code: input.session.participantCode },
    session: {
      id: input.session.id,
      status: input.session.status,
      startedAt: input.session.startedAt,
      lastActivityAt: input.session.lastActivityAt,
      cozeConversationId: input.session.cozeConversationId,
      provider: input.session.provider ?? "coze",
      ...(input.session.provider === "dify" ? { difyConversationId: input.session.difyConversationId ?? null } : {}),
      experimentRunId: input.session.experimentRunId,
      agentId: input.session.agentId,
    },
    experiment: {
      id: input.experiment.id,
      label: input.experiment.label,
      title: input.experiment.title,
      assistantName: input.experiment.assistantName,
      welcomeMessage: input.experiment.welcome,
    },
    storage: {
      databaseMessagesEnabled: input.databaseMessagesEnabled,
      browserBackupIncluded: input.browserBackupIncluded,
    },
    integrity: {
      messageCount: messages.length,
      turnCount: new Set(messages.map((message) => message.turnIndex)).size,
      participantMessageCount: messages.filter((message) => message.role === "user").length,
      assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
    },
    messages: messages.map((message, index) => ({
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
      ...(message.provider === "dify" ? { provider: message.provider, providerMessageId: message.providerMessageId ?? null, providerTaskId: message.providerTaskId ?? null } : {}),
    })),
  };
}

export function safeExportSegment(value: string, fallback: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || fallback;
}

export type ParticipantConversationExport = ReturnType<typeof buildTranscriptExport> & {
  title: string;
  completedAt: string | null;
  interaction: { id: string | null; previousSessionId: string | null };
  integrity: { requestCount: number; pending: boolean; possiblyIncomplete: boolean };
};

export interface ParticipantTranscriptArchive {
  schemaVersion: 1;
  type: "participant-interaction-archive";
  source: "database" | "database_and_browser";
  exportedAt: string;
  participant: { code: string };
  experimentId: string;
  experimentRunId: string | null;
  currentSessionId: string;
  integrity: { sessionCount: number; messageCount: number; possiblyIncompleteSessionCount: number };
  conversations: ParticipantConversationExport[];
}

// Only supplement sessions whose experiment explicitly disabled database text
// storage. Confirmed database messages take precedence over browser copies.
export function includeBrowserTranscriptBackups(archive: ParticipantTranscriptArchive, experiment: ExperimentConfig,
  readMessages: (sessionId: string) => StoredMessage[]): ParticipantTranscriptArchive {
  let included = false;
  const conversations = archive.conversations.map(record => {
    if (record.storage.databaseMessagesEnabled) return record;
    const local = readMessages(record.session.id);
    if (!local.length) return record;
    included = true;
    const backup = buildTranscriptExport({exportedAt:archive.exportedAt,
      session:{...record.session,participantCode:archive.participant.code},
      experiment, databaseMessagesEnabled:false, browserBackupIncluded:true, messages:local});
    const bySequence = new Map([...backup.messages,...record.messages].map(message => [message.sequenceNo,message]));
    const messages = [...bySequence.values()].sort((a,b)=>a.sequenceNo-b.sequenceNo).map((message,index)=>({...message,order:index+1}));
    return {...record,storage:{...record.storage,browserBackupIncluded:true},messages,
      integrity:{...record.integrity,messageCount:messages.length,turnCount:new Set(messages.map(message=>message.turnIndex)).size,
        participantMessageCount:messages.filter(message=>message.role==="user").length,
        assistantMessageCount:messages.filter(message=>message.role==="assistant").length}};
  });
  return {...archive,source:included ? "database_and_browser" : archive.source,conversations,
    integrity:{...archive.integrity,messageCount:conversations.reduce((sum,record)=>sum+record.messages.length,0)}};
}
