import type { ExperimentConfig } from "@/config/experiment";
import type { StoredMessage } from "@/db/schema";

export interface TranscriptExportSession {
  id: string;
  status: "active" | "completed";
  startedAt: string;
  lastActivityAt: string;
  participantCode: string;
  cozeConversationId: string | null;
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
    })),
  };
}

export function safeExportSegment(value: string, fallback: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || fallback;
}
