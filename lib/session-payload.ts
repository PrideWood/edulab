import "server-only";

import type { StoredMessage } from "@/db/schema";
import { recoverPendingRequest } from "@/lib/coze";
import { getSessionControls } from "@/lib/experiment-limits";
import { getLatestFailedRequest, listMessages } from "@/lib/messages";
import type { AuthenticatedSession } from "@/lib/session";

export async function buildSessionPayload(session: AuthenticatedSession) {
  let pending = Boolean(session.activeRequestId);
  let transientMessages: StoredMessage[] = [];
  const storedMessages = await listMessages(session.id);
  if (pending || storedMessages.length === 0) {
    try {
      const recovery = await recoverPendingRequest(session);
      pending = recovery.pending;
      transientMessages = recovery.messages;
    } catch (error) {
      console.error(pending ? "Pending request recovery failed" : "Latest response recovery failed", error);
    }
  }
  const state = await getSessionControls(session);
  const messages = [...storedMessages, ...transientMessages.filter((message) => !storedMessages.some((stored) => stored.id === message.id))]
    .sort((a, b) => a.sequenceNo - b.sequenceNo);
  return {
    session: {
      id: session.publicId, status: state.status, startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt, participantCode: session.participantCode,
      cozeConversationId: session.cozeConversationId,
    },
    messages,
    pending,
    failedRequest: pending ? null : await getLatestFailedRequest(session.id),
    controls: state.controls,
  };
}
