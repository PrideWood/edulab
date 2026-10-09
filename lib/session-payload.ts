import "server-only";

import { getSessionDraft } from "@/lib/session-draft";
import type { StoredMessage } from "@/db/schema";
import { recoverPendingRequest } from "@/lib/coze";
import { getSessionControls } from "@/lib/experiment-limits";
import { getLatestFailedRequest, listMessages, mergeStoredMessages } from "@/lib/messages";
import { getParticipantProfile } from "@/lib/participant-profile";
import type { AuthenticatedSession } from "@/lib/session";

export async function buildSessionPayload(session: AuthenticatedSession, options: { includeMessages?: boolean } = {}) {
  let pending = Boolean(session.activeRequestId);
  let transientMessages: StoredMessage[] = [];

  try {
    const recovery = options.includeMessages === false
      ? { pending: false, messages: [] }
      : await recoverPendingRequest(session);
    pending = recovery.pending;
    transientMessages = recovery.messages;
  } catch (error) {
    console.error(pending ? "Pending request recovery failed" : "Latest response recovery failed", error);
  }
  const state = await getSessionControls(session);
  const storedMessages = options.includeMessages === false ? [] : await listMessages(session.id);
  const messages = mergeStoredMessages(storedMessages, transientMessages);
  return {
    session: {
      id: session.publicId, status: state.status, startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt, participantCode: session.participantCode,
      cozeConversationId: session.cozeConversationId,
      experimentRunId: session.configSnapshot?.ai.runId ?? null,
      agentId: session.configSnapshot?.ai.agentId ?? null,
    },
    experiment: state.snapshot.experiment,
    draft: await getSessionDraft(session.id),
    messages,
    participantProfile: await getParticipantProfile(session.participantId),
    pending,
    failedRequest: pending ? null : await getLatestFailedRequest(session.id),
    controls: state.controls,
  };
}
