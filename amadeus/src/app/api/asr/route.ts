import { NextResponse } from "next/server";

/**
 * 语音识别(ASR)代理：调用 MiMo ASR（OpenAI 兼容的 /chat/completions）。
 * 入参：{ audio: dataURL, apiKey, endpoint, model }
 * 音频以 data URL（data:audio/wav;base64,...）放进 input_audio。
 */
export async function POST(request: Request) {
  try {
    const { audio, apiKey, endpoint, model } = await request.json();

    const key = (apiKey || "").trim();
    if (!key) return NextResponse.json({ error: "未配置 ASR API Key" }, { status: 400 });
    if (!audio) return NextResponse.json({ error: "无音频数据" }, { status: 400 });
    const base = (endpoint || "").trim();
    if (!base) return NextResponse.json({ error: "未配置 ASR 接口地址" }, { status: 400 });

    const asrModel = (model || "mimo-v2.5-asr").trim();
    const url = `${base.replace(/\/$/, "")}/chat/completions`;

    const t0 = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: asrModel,
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: audio } }],
          },
        ],
        asr_options: { language: "auto" },
        stream: false,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      let errMsg = `ASR 请求失败（${res.status}）`;
      try {
        const j = JSON.parse(errText);
        errMsg = j.error?.message || errMsg;
      } catch {
        if (errText) errMsg = errText.slice(0, 200);
      }
      console.error("[ASR route] 上游错误:", res.status, errMsg);
      // 401/403 多半是 Key 问题，给个更友好的提示
      if (res.status === 401 || res.status === 403) {
        errMsg = `鉴权失败（${res.status}）：ASR Key 无效或与对话 Key 不同，请到设置→语音输入里填独立的 ASR Key。`;
      }
      return NextResponse.json({ error: errMsg }, { status: 502 });
    }

    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content?.trim() || "";
    console.log(`[ASR route] 识别耗时 ${Date.now() - t0}ms，文本长度 ${text.length}`);
    return NextResponse.json({ text });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "ASR 处理失败";
    console.error("[ASR route] 异常:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
