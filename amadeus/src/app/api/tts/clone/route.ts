import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

/**
 * 一键克隆红莉栖音色（Qwen3-TTS-VC 路径）
 *
 * 为什么用 Qwen 声音复刻而不是 CosyVoice：
 * - CosyVoice 声音复刻需要音频的公网 URL，本地桌面应用做不到（阿里云访问不到 localhost）
 * - Qwen 声音复刻支持 base64 直接上传音频，无需公网 URL，本地可用
 *
 * 流程：
 * 1. 读取内置 public/voice_sample.mp3（红莉栖音色样本，~360KB）
 * 2. 转 base64 data URL
 * 3. 调阿里云 qwen-voice-enrollment API（action=create）
 * 4. 返回 voice（音色名），前端存到 localStorage
 * 5. 之后 TTS 合成用 qwen3-tts-vc 引擎 + 这个 voice
 *
 * 注意：每个阿里云账号声音复刻数量有限（通常 20 个），
 * 重复克隆会创建多个音色。前端做了"已克隆则不重复"的判断。
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { apiKey: string; characterId?: string };
    const { apiKey: rawApiKey } = body;
    const apiKey = (rawApiKey || "").trim();

    if (!apiKey) {
      return NextResponse.json(
        { error: "请先填写阿里云 API Key" },
        { status: 400 }
      );
    }

    // 1. 读取内置音色样本
    // 1. 读取内置音色样本（按角色 ID 取不同样本）
    const { characterId } = body as { apiKey: string; characterId?: string };
    // 角色到音色样本文件的映射
    const voiceSamples: Record<string, string> = {
      kurisu: "voice_sample.mp3",
      maho: "voice_sample_maho.wav",
      may: "voice_sample_may.wav",
    };
    const sampleFile = voiceSamples[characterId || "kurisu"] || "voice_sample.mp3";
    // Next.js standalone 模式下 cwd 可能是 amadeus/ 目录，也可能是 standalone/
    // 尝试两个路径，找到第一个存在的
    const possiblePaths = [
      path.join(process.cwd(), "public", sampleFile),
      path.join(process.cwd(), "amadeus", "public", sampleFile),
    ];
    const samplePath = possiblePaths.find((p) => fs.existsSync(p));
    if (!samplePath) {
      return NextResponse.json(
        { error: `内置音色样本文件不存在（public/${sampleFile}），尝试过: ${possiblePaths.join(", ")}` },
        { status: 500 }
      );
    }
    const audioBuffer = fs.readFileSync(samplePath);
    const base64 = audioBuffer.toString("base64");
    // 根据文件类型设置正确的 MIME type
    const mimeType = sampleFile.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
    const dataUrl = `data:${mimeType};base64,${base64}`;
    console.log(`[TTS clone] 角色=${characterId}, 样本=${sampleFile}, 路径=${samplePath}, 大小=${(audioBuffer.length / 1024).toFixed(1)}KB`);

    // 2. 调阿里云 Qwen 声音复刻 API
    // 用 dashscope 默认域名（不需要 WorkspaceId 专属域名，通用）
    const cloneUrl = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization";
    const t0 = Date.now();

    // preferred_name 按角色区分，方便用户在阿里云控制台辨认
    const preferredNames: Record<string, string> = {
      kurisu: "amadeus_kurisu",
      maho: "amadeus_maho",
      may: "amadeus_may",
    };
    const preferredName = preferredNames[characterId || "kurisu"] || "amadeus_kurisu";

    const res = await fetch(cloneUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "qwen-voice-enrollment",
        input: {
          action: "create",
          target_model: "qwen3-tts-vc-2026-01-22",
          preferred_name: preferredName,
          audio: { data: dataUrl },
          language: "ja",
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[TTS clone] 阿里云错误:", res.status, errText);
      // 解析错误信息给用户更友好的提示
      let hint = "";
      if (res.status === 401) hint = "（API Key 无效或未开通百炼服务）";
      else if (res.status === 403) hint = "（可能未实名认证，或声音复刻服务未开通）";
      return NextResponse.json(
        { error: `阿里云返回 ${res.status}${hint}：${errText.slice(0, 300)}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    console.log(`[TTS clone] 克隆耗时: ${Date.now() - t0}ms, 返回:`, JSON.stringify(data).slice(0, 300));

    const voice = data?.output?.voice;
    if (!voice) {
      return NextResponse.json(
        { error: "克隆成功但未返回音色名，请重试" },
        { status: 500 }
      );
    }

    console.log(`[TTS clone] 克隆成功! voice=${voice}, 角色=${characterId}, 样本=${sampleFile}`);
    return NextResponse.json({
      voice,
      sampleFile,
      characterId: characterId || "kurisu",
      fallbackMode: data?.output?.fallback_mode || false,
      fallbackReason: data?.output?.fallback_reason || "",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "克隆请求失败";
    console.error("[TTS clone] 异常:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
