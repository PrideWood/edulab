export type MessageRole = "user" | "assistant";
export type SessionStatus = "active" | "completed";
export type RequestStatus = "in_progress" | "completed" | "failed" | "uncertain";

export interface StoredMessage {
  id: string;
  sequenceNo: number;
  role: MessageRole;
  content: string;
  sentAt: string;
  replyStartedAt: string | null;
  replyCompletedAt: string | null;
  latencyMs: number | null;
  clientRequestId: string | null;
  status: "completed";
}
