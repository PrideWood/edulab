export interface InteractionStartAction {
  action: "start_interaction";
  clientRequestId: string;
  expectedSessionId: string;
}

export interface PendingInteractionStart extends InteractionStartAction {
  automaticLogin?: boolean;
}

type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function interactionStartKey(scope: string, participantCode: string) {
  return `edulab_new_interaction:${scope}:${participantCode}`;
}

export function readInteractionStart(storage: RequestStorage, key: string): PendingInteractionStart | null {
  try {
    const saved = JSON.parse(storage.getItem(key) ?? "null");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (saved?.action === "start_interaction" && uuid.test(saved.clientRequestId) && uuid.test(saved.expectedSessionId)) return saved;
  } catch { /* Invalid browser data cannot authorize a new interaction. */ }
  return null;
}

// Only an explicit, verified login creates an intent. On refresh, replay an
// unfinished intent with its original ID; a normal credential restore is inert.
export async function startLoginInteraction<T>(options: {
  storage: RequestStorage;
  key: string;
  sessionId: string;
  retryOnly?: boolean;
  newRequestId: () => string;
  prepare: () => Promise<void>;
  start: (action: InteractionStartAction) => Promise<T>;
}): Promise<T | null> {
  const saved = readInteractionStart(options.storage, options.key);
  if (options.retryOnly && !saved?.automaticLogin) return null;
  const action: PendingInteractionStart = {
    ...(saved ?? {action:"start_interaction", clientRequestId:options.newRequestId(), expectedSessionId:options.sessionId}),
    automaticLogin: true,
  };
  try { options.storage.setItem(options.key, JSON.stringify(action)); }
  catch { throw new Error("浏览器未能保存新交互请求，尚未开启新会话。请允许本站保存本地数据后重试。"); }
  await options.prepare();
  const result = await options.start(action);
  try { options.storage.removeItem(options.key); } catch { /* A retained intent safely replays the committed request. */ }
  return result;
}
