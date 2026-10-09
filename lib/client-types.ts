import type { ExperimentConfig } from "@/config/experiment";
import type { StoredMessage } from "@/db/schema";
import type { SessionControls } from "@/lib/experiment-limits";

export interface ParticipantProfile {
  fullName: string;
  studentNumber: string;
  updatedAt: string;
}

export interface SessionPayload {
  session: {
    id: string;
    status: "active" | "completed";
    startedAt: string;
    lastActivityAt: string;
    participantCode: string;
    cozeConversationId: string | null;
    experimentRunId: string | null;
    agentId: string | null;
  };
  experiment?: ExperimentConfig;
  draft?: { text: string; revision: number };
  messages: StoredMessage[];
  participantProfile: ParticipantProfile | null;
  pending: boolean;
  failedRequest?: { content: string; message: string; retryable?: boolean } | null;
  controls: SessionControls;
}
