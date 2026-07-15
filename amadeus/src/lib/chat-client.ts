/**
 * 复用的对话调用客户端：流式请求 /api/chat，返回完整回复文本。
 * 与 Chat.tsx 里的 sendMessage 逻辑保持一致（同样的 payload 结构，服务端拼 system prompt）。
 * VoiceCall 直接复用，避免改造已稳定的 Chat 流程。
 */

export interface ChatTurnConfig {
  endpoint: string;
  apiKey: string;
  model: string;
}

export interface ChatTurnOptions {
  message: string;
  history: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
  memories: Array<{ content: string; type: string }>;
  personality: string;
  config: ChatTurnConfig;
  onDelta?: (delta: string) => void;
}

/** 流式调用 /api/chat，逐字回调 onDelta，最终 resolve 完整回复文本。 */
export async function streamChatTurn(opts: ChatTurnOptions): Promise<string> {
  const { message, history, memories, personality, config, onDelta } = opts;

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      history,
      memories,
      personality,
      ...config,
    }),
  });

  if (!res.ok || !res.body) {
    const errData = await res.json().catch(() => ({ error: "请求失败" }));
    throw new Error(errData.error || "请求失败");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const evt of events) {
      const line = evt.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.content) {
          full += parsed.content;
          onDelta?.(parsed.content);
        }
      } catch {
        // 忽略不完整 chunk
      }
    }
  }

  return full;
}
