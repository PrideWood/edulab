// Shared by the server-side Dify adapter and the browser. Decode across UTF-8
// and CRLF chunk boundaries, including comments, ping and multiline data.
export async function* readSse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let frameSize = 0;
  function line(value: string) {
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (value === "") {
      const result = data.length ? data.join("\n") : null;
      data = []; frameSize = 0;
      return result;
    }
    if (value.startsWith("data:")) {
      const part = value.slice(5).replace(/^ /, "");
      frameSize += part.length;
      if (frameSize > 1_000_000) throw new Error("SSE event is too large");
      data.push(part);
    }
    return null;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const frame = line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (frame !== null) yield frame;
      }
      if (buffer.length > 1_000_000) throw new Error("SSE line is too large");
      if (done) {
        if (buffer) line(buffer);
        const frame = line("");
        if (frame !== null) yield frame;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
