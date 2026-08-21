import type { StoredMessage } from "@/db/schema";
import type { SessionControls } from "@/lib/experiment-limits";

export interface SessionPayload {
  session: {
    id: string;
    status: "active" | "completed";
    startedAt: string;
    lastActivityAt: string;
    participantCode: string;
  };
  messages: StoredMessage[];
  pending: boolean;
  failedRequest?: { content: string; message: string } | null;
  controls: SessionControls;
}
