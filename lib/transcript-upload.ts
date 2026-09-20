import type { StoredMessage } from "@/db/schema";

// Keep an entire turn in each chunk; every assistant needs its user request.
// Use ordinary fetch (with acknowledgements), not unload's 64 KiB queue.
export function transcriptChunks(messages: StoredMessage[], maxBytes = 512_000) {
  const turns = new Map<number, StoredMessage[]>();
  for (const message of messages) {
    const group = turns.get(message.turnIndex) ?? [];
    group.push(message);
    turns.set(message.turnIndex, group);
  }
  const chunks: StoredMessage[][] = [];
  let chunk: StoredMessage[] = [];
  for (const group of turns.values()) {
    if (new TextEncoder().encode(JSON.stringify({ messages: group })).byteLength > maxBytes) {
      throw new Error("单轮记录过大，请下载交互记录并交给实验人员。");
    }
    if (chunk.length && new TextEncoder().encode(JSON.stringify({ messages: [...chunk, ...group] })).byteLength > maxBytes) {
      chunks.push(chunk); chunk = [];
    }
    chunk.push(...group);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

export async function uploadTranscript(sessionId: string, messages: StoredMessage[]) {
  for (const chunk of transcriptChunks(messages)) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch("/api/sessions/checkpoint", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, messages: chunk }),
          signal: AbortSignal.timeout(90000),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.saved) {
          const error = Object.assign(new Error(data?.error?.message ?? "交互记录尚未提交成功，请稍后重试。"), {
            retryable: response.status === 429 || response.status >= 500,
          });
          throw error;
        }
        break;
      } catch (error) {
        if (attempt >= 2 || (error as { retryable?: boolean }).retryable === false) throw error;
        await new Promise(resolve => setTimeout(resolve, 1500 * 2 ** attempt + Math.random() * 1500));
      }
    }
  }
}
