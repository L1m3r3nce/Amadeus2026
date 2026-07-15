/**
 * 客户端语音识别(ASR)封装 + ASR 配置存储。
 * ASR 拥有独立的「模型 / 接口 / API Key」配置，与对话模型分开。
 * API Key 留空时，自动回退复用对话模型的 Key。
 */

const ASR_ENABLED_KEY = "amadeus_asr_enabled";
const ASR_MODEL_KEY = "amadeus_asr_model";
const ASR_ENDPOINT_KEY = "amadeus_asr_endpoint";
const ASR_KEY_KEY = "amadeus_asr_key";

// 默认值：小米 MiMo ASR
export const DEFAULT_ASR_MODEL = "mimo-v2.5-asr";
export const DEFAULT_ASR_ENDPOINT = "https://api.xiaomimimo.com/v1";

export interface AsrConfig {
  enabled: boolean;
  model: string;
  endpoint: string;
  apiKey: string; // 留空 → 复用对话模型 Key
}

export function loadAsrConfig(): AsrConfig {
  if (typeof window === "undefined") {
    return { enabled: true, model: DEFAULT_ASR_MODEL, endpoint: DEFAULT_ASR_ENDPOINT, apiKey: "" };
  }
  const enabled = localStorage.getItem(ASR_ENABLED_KEY);
  return {
    enabled: enabled === null ? true : enabled === "true",
    model: localStorage.getItem(ASR_MODEL_KEY) || DEFAULT_ASR_MODEL,
    endpoint: localStorage.getItem(ASR_ENDPOINT_KEY) || DEFAULT_ASR_ENDPOINT,
    apiKey: localStorage.getItem(ASR_KEY_KEY) || "",
  };
}

export function saveAsrConfig(cfg: AsrConfig) {
  localStorage.setItem(ASR_ENABLED_KEY, String(cfg.enabled));
  localStorage.setItem(ASR_MODEL_KEY, cfg.model);
  localStorage.setItem(ASR_ENDPOINT_KEY, cfg.endpoint);
  localStorage.setItem(ASR_KEY_KEY, (cfg.apiKey || "").trim());
}

// 兼容旧版零散读取（Chat 顶部按钮显隐用）
export function loadAsrEnabled(): boolean {
  return loadAsrConfig().enabled;
}

/**
 * 解析实际调用 ASR 用的鉴权信息：ASR 自己的 Key 优先，留空则回退对话 Key。
 */
export function resolveAsrAuth(chatConfig: { apiKey: string; endpoint: string }): {
  apiKey: string;
  endpoint: string;
  model: string;
} {
  const cfg = loadAsrConfig();
  return {
    apiKey: (cfg.apiKey || "").trim() || (chatConfig.apiKey || "").trim(),
    endpoint: (cfg.endpoint || "").trim() || (chatConfig.endpoint || "").trim(),
    model: (cfg.model || "").trim() || DEFAULT_ASR_MODEL,
  };
}

/**
 * 把一整段 wav data URL 发给 /api/asr，返回识别文本。失败抛 Error（中文提示）。
 */
export async function transcribeAudio(
  dataUrl: string,
  auth: { apiKey: string; endpoint: string; model: string }
): Promise<string> {
  const res = await fetch("/api/asr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio: dataUrl,
      apiKey: auth.apiKey,
      endpoint: auth.endpoint,
      model: auth.model,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || `ASR 失败（HTTP ${res.status}）`);
  }
  return data.text || "";
}
