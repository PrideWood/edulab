export interface ComposerDraft {
  sessionId: string;
  text: string;
  savedText: string;
  revision: number;
  conflict: boolean;
}

// A confirmed send clears the server draft and advances its revision. That is
// not a competing edit; preserve anything typed since the send and rebase it.
export function reconcileComposerDraft(current: ComposerDraft, remote: { text: string; revision: number }, sentConfirmed: boolean): ComposerDraft {
  if (current.text === current.savedText || current.text === remote.text) {
    return { ...current, text: remote.text, savedText: remote.text, revision: remote.revision, conflict: false };
  }
  if (sentConfirmed && remote.text === "" && remote.revision > current.revision) {
    return { ...current, savedText: "", revision: remote.revision, conflict: false };
  }
  return { ...current, conflict: current.conflict || remote.revision !== current.revision };
}
