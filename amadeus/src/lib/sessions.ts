import { MemoryEntry } from "./memory";
import { getSessionCharacterId } from "./auth";
import { getRandomGreeting as getCharacterGreeting, DEFAULT_CHARACTER } from "./characters";
export interface Message {
  role: "user" | "assistant";
  content: string;
  imageUrl?: string;
  /** 标记为上下文摘要（压缩产物），发 LLM 时作为 system 消息注入 */
  isSummary?: boolean;
}

export interface Session {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  memories: MemoryEntry[];
}

const DEFAULT_SESSION_NAME = "默认会话";

// === 会话存储按角色 ID 隔离 ===
// 不同角色用不同的 localStorage key，互不干扰
function getSessionsKey(): string {
  const charId = typeof window !== "undefined" ? getSessionCharacterId() : DEFAULT_CHARACTER.id;
  return `amadeus_sessions_${charId}`;
}
function getActiveSessionKey(): string {
  const charId = typeof window !== "undefined" ? getSessionCharacterId() : DEFAULT_CHARACTER.id;
  return `amadeus_active_session_${charId}`;
}

// 兼容旧版本（红莉栖角色 ID = kurisu）的迁移 key
const LEGACY_SESSIONS_KEY = "amadeus_sessions";
const LEGACY_ACTIVE_SESSION_KEY = "amadeus_active_session";
const OLD_MESSAGES_KEY = "amadeus_messages";
const OLD_MEMORIES_KEY = "amadeus_memories";

export function loadSessions(): Session[] {
  if (typeof window === "undefined") return [];
  const sessionsKey = getSessionsKey();
  // 优先读角色专属 key
  const saved = localStorage.getItem(sessionsKey);
  if (saved) return JSON.parse(saved);
  // 迁移：红莉栖角色首次切到新 key 时，从旧 key 复制
  const charId = getSessionCharacterId();
  if (charId === DEFAULT_CHARACTER.id) {
    const legacy = localStorage.getItem(LEGACY_SESSIONS_KEY);
    if (legacy) {
      localStorage.setItem(sessionsKey, legacy);
      return JSON.parse(legacy);
    }
  }
  return [];
}

export function saveSessions(sessions: Session[]) {
  localStorage.setItem(getSessionsKey(), JSON.stringify(sessions));
}

export function loadActiveSessionId(): string {
  if (typeof window === "undefined") return "";
  const activeKey = getActiveSessionKey();
  const saved = localStorage.getItem(activeKey);
  if (saved) return saved;
  // 迁移
  const charId = getSessionCharacterId();
  if (charId === DEFAULT_CHARACTER.id) {
    return localStorage.getItem(LEGACY_ACTIVE_SESSION_KEY) || "";
  }
  return "";
}

export function saveActiveSessionId(id: string) {
  localStorage.setItem(getActiveSessionKey(), id);
}

export function getActiveSession(): Session | null {
  const sessions = loadSessions();
  const activeId = loadActiveSessionId();
  return sessions.find((s) => s.id === activeId) || null;
}

export function ensureDefaultSession(): Session {
  let sessions = loadSessions();

  if (sessions.length === 0) {
    const oldMessages = localStorage.getItem(OLD_MESSAGES_KEY);
    const oldMemories = localStorage.getItem(OLD_MEMORIES_KEY);

    const defaultSession: Session = {
      id: Date.now().toString(),
      name: DEFAULT_SESSION_NAME,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: oldMessages ? JSON.parse(oldMessages) : [{ role: "assistant" as const, content: getCharacterGreeting(getSessionCharacterId()) }],
      memories: oldMemories ? JSON.parse(oldMemories) : [],
    };
    sessions = [defaultSession];
    saveSessions(sessions);
    saveActiveSessionId(defaultSession.id);
    return defaultSession;
  }

  const activeId = loadActiveSessionId();
  if (!activeId || !sessions.find((s) => s.id === activeId)) {
    saveActiveSessionId(sessions[0].id);
    return sessions[0];
  }

  return sessions.find((s) => s.id === activeId)!;
}

export function createSession(name?: string): Session {
  const sessions = loadSessions();
  const newSession: Session = {
    id: Date.now().toString(),
    name: name || `会话 ${sessions.length + 1}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [{ role: "assistant" as const, content: getCharacterGreeting(getSessionCharacterId()) }],
    memories: [],
  };
  sessions.push(newSession);
  saveSessions(sessions);
  saveActiveSessionId(newSession.id);
  return newSession;
}

export function updateSession(id: string, updates: Partial<Pick<Session, "name" | "messages" | "memories">>) {
  const sessions = loadSessions();
  const index = sessions.findIndex((s) => s.id === id);
  if (index === -1) return;

  sessions[index] = {
    ...sessions[index],
    ...updates,
    updatedAt: Date.now(),
  };
  saveSessions(sessions);
}

export function deleteSession(id: string): boolean {
  const sessions = loadSessions();
  if (sessions.length <= 1) return false;

  const filtered = sessions.filter((s) => s.id !== id);
  saveSessions(filtered);

  if (loadActiveSessionId() === id) {
    saveActiveSessionId(filtered[0].id);
  }

  return true;
}

export function renameSession(id: string, name: string) {
  updateSession(id, { name });
}

// === 上下文压缩 ===

/** 压缩阈值：消息数超过此值时建议压缩 */
export const COMPRESS_THRESHOLD = 40;
/** 压缩后保留的最近消息数（原文不动） */
export const KEEP_RECENT = 20;

const COMPRESS_PROMPT = `请将以下对话历史压缩成一条简洁的摘要，供 AI 保持上下文连贯。

要求：
- 保留关键信息：讨论的话题、用户的偏好/立场、重要决定、未完成的事
- 丢弃闲聊、重复内容、已解决的细节
- 用第三人称陈述，如"用户询问了X，Amadeus回答了Y"
- 不超过 300 字
- 不要分条，输出一段连续文字

对话历史：
`;

/**
 * 用 LLM 把旧消息压缩成摘要。
 * - 保留最近 KEEP_RECENT 条原文
 * - 更早的消息 + 已有的旧摘要一起送给 LLM 总结
 * - 总结结果作为一条 isSummary=true 的消息插入到保留消息之前
 * @returns 压缩后的消息数（-1 表示无需压缩，-2 表示失败）
 */
export async function compressSessionMessages(
  sessionId: string,
  config: { endpoint: string; apiKey: string; model: string }
): Promise<number> {
  const session = loadSessions().find((s) => s.id === sessionId);
  if (!session) return -2;

  const msgs = session.messages;
  if (msgs.length <= COMPRESS_THRESHOLD) return -1; // 不需要压缩

  // 分割：要压缩的部分 + 保留的最近部分
  const toCompress = msgs.slice(0, msgs.length - KEEP_RECENT);
  const toKeep = msgs.slice(msgs.length - KEEP_RECENT);

  if (!config.apiKey) return -2;

  // 构造压缩用对话文本
  // 图片消息只加 [图片] 占位符，不把 base64 发给压缩 LLM（避免 token 浪费 + 截断乱码）
  const dialogText = toCompress
    .map((m) => {
      let text = m.content.slice(0, 500);
      if (m.imageUrl) {
        text = `[发送了一张图片] ${text}`;
      }
      return `${m.role === "user" ? "用户" : "Amadeus"}: ${text}`;
    })
    .join("\n");

  try {
    const res = await fetch(`${config.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: COMPRESS_PROMPT + dialogText }],
        max_tokens: 512,
      }),
    });
    const data = await res.json();
    if (data.error) return -2;

    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) return -2;

    // 组装新消息列表：摘要消息 + 保留的最近消息
    const summaryMessage: Message = {
      role: "assistant",
      content: `[上下文摘要] ${summary}`,
      isSummary: true,
    };
    const newMessages = [summaryMessage, ...toKeep];

    updateSession(sessionId, { messages: newMessages });
    return newMessages.length;
  } catch {
    return -2;
  }
}
