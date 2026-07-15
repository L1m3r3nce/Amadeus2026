"use client";

import { useEffect, useRef, useState } from "react";
import {
  loadTTSConfig,
  synthesizeSpeech,
  playAudio,
  stopCurrentAudio,
  TTSConfig,
} from "@/lib/tts";
import { transcribeAudio, resolveAsrAuth } from "@/lib/asr";
import { streamChatTurn } from "@/lib/chat-client";
import { getTTSText } from "@/lib/message-parser";
import { dispatchEmotion } from "@/lib/emotion";
import { getActiveSession, updateSession, Session } from "@/lib/sessions";
import { loadModelConfig } from "@/components/Settings";
import { Character } from "@/lib/characters";
import { decodeAudioBlob, encodeWav, blobToDataUrl, pickRecorderMime } from "@/lib/audio";

type Phase = "connecting" | "listening" | "processing" | "speaking" | "ended";

// === VAD 参数 ===
const START_THRESH = 0.018; // 开始说话的 RMS 阈值
const END_THRESH = 0.012; // 结束说话的 RMS 阈值
const START_FRAMES = 3; // 连续多少帧超阈值才判定"开始说话"
const SILENCE_MS = 1100; // 静音持续多久判定"一句话结束"
const MAX_UTTERANCE_MS = 15000; // 单次最长录音（防止一直不结束）
const CONNECTING_MS = 1300; // "正在接通" 动画时长

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function VoiceCall({
  open,
  onClose,
  sessionId,
  character,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  character: Character;
}) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subtitle, setSubtitle] = useState("正在接通…");
  const [youSaid, setYouSaid] = useState("");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // === 可变循环状态（用 ref，避免重渲染打断 rAF 循环） ===
  const callActiveRef = useRef(false);
  const speakingRef = useRef(false); // 她正在思考/说话 → 暂停 VAD 监听
  const recordingRef = useRef(false);
  const mutedRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const ttsAnalyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startFramesRef = useRef(0);
  const silentFramesRef = useRef(0);
  const utteranceStartRef = useRef(0);
  const rafMonitorRef = useRef(0);
  const rafDrawRef = useRef(0);
  const timerRef = useRef(0);
  const connectTimerRef = useRef(0);

  // 监听 TTS 声波事件（她说话时可视化用），定义为稳定函数以便清理
  const onTtsStart = (ev: Event) => {
    const detail = (ev as CustomEvent).detail;
    if (detail && detail.analyser) ttsAnalyserRef.current = detail.analyser as AnalyserNode;
  };

  const getRms = (analyser: AnalyserNode | null): number => {
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  };

  // === 处理一次"说完的话"：转写 → LLM → TTS ===
  const handleUtteranceEnd = async (blob: Blob) => {
    try {
      const cfg = loadModelConfig();
      if (!cfg.apiKey) {
        setError("未配置对话 Key，无法识别/回复");
        setPhase("listening");
        setSubtitle("聆听中，请说话");
        return;
      }
      const ctx = audioCtxRef.current;
      if (!ctx) {
        setPhase("listening");
        return;
      }

      // 录制的是 webm/ogg，转成 MiMo 认的 wav
      let wavBlob: Blob;
      try {
        const audioBuf = await decodeAudioBlob(blob, ctx);
        wavBlob = encodeWav(audioBuf);
      } catch (e) {
        console.error("[VoiceCall] 解码录音失败:", e);
        setError("录音格式无法识别，请重试");
        setPhase("listening");
        setSubtitle("聆听中，请说话");
        return;
      }
      const dataUrl = await blobToDataUrl(wavBlob);

      // ASR（ASR Key 留空时自动回退对话 Key）
      const asrAuth = resolveAsrAuth({ apiKey: cfg.apiKey, endpoint: cfg.endpoint });
      const text = (await transcribeAudio(dataUrl, asrAuth)).trim();

      if (!text) {
        setPhase("listening");
        setSubtitle("没听清，再说一次？");
        return;
      }

      setYouSaid(text);
      setSubtitle("思考中…");
      setPhase("processing");

      // 写入会话（用户消息）
      const pushUser = getActiveSession();
      if (pushUser) {
        updateSession(pushUser.id, {
          messages: [...pushUser.messages, { role: "user", content: text }],
        });
        window.dispatchEvent(new CustomEvent("amadeus-session-updated"));
      }

      // 构造历史 + 记忆
      const s2: Session | null = getActiveSession();
      const history = (s2 ? s2.messages : [])
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content }));
      const memories = (s2 ? s2.memories : []).map((m) => ({ content: m.content, type: m.type }));

      // LLM
      let full = "";
      try {
        full = await streamChatTurn({
          message: text,
          history,
          memories,
          personality: character.personality,
          config: { endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model },
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "回复失败");
        setPhase("listening");
        setSubtitle("聆听中，请说话");
        return;
      }

      if (!full) {
        setPhase("listening");
        setSubtitle("聆听中，请说话");
        return;
      }

      // 写入会话（助手消息）
      const s3 = getActiveSession();
      if (s3) {
        updateSession(s3.id, {
          messages: [...s3.messages, { role: "assistant", content: full }],
        });
        window.dispatchEvent(new CustomEvent("amadeus-session-updated"));
      }

      // 表情驱动（通话里也让她有表情变化）
      dispatchEmotion(full);

      // TTS 播放（口型通过 amadeus-tts-start 事件自动同步到 Live2D）
      setPhase("speaking");
      setSubtitle(`${character.name} 正在说话…`);
      speakingRef.current = true;

      const ttsConfig: TTSConfig = loadTTSConfig();
      if (ttsConfig.enabled) {
        const audio = await synthesizeSpeech(getTTSText(full), ttsConfig);
        if (audio) {
          try {
            await playAudio(audio);
          } catch {
            /* 忽略播放错误 */
          }
        }
      }

      speakingRef.current = false;
      setPhase("listening");
      setSubtitle("聆听中，请说话");
      window.dispatchEvent(
        new CustomEvent("amadeus-emotion", { detail: { emotion: "neutral", intensity: 0, duration: 0 } })
      );
    } catch (e) {
      console.error("[VoiceCall] 处理话语异常:", e);
      setError(e instanceof Error ? e.message : "出错了");
      speakingRef.current = false;
      recordingRef.current = false;
      setPhase("listening");
      setSubtitle("聆听中，请说话");
    }
  };

  const startUtterance = () => {
    if (recordingRef.current || !recorderRef.current) return;
    recordingRef.current = true;
    chunksRef.current = [];
    utteranceStartRef.current = performance.now();
    silentFramesRef.current = 0;
    try {
      recorderRef.current.start();
    } catch {
      /* 已在录制则忽略 */
    }
    setSubtitle("听到了，继续说…");
  };

  const endUtterance = () => {
    if (!recordingRef.current || !recorderRef.current) return;
    recordingRef.current = false;
    try {
      recorderRef.current.stop();
    } catch {
      /* 忽略 */
    }
    setPhase("processing");
    setSubtitle("识别中…");
  };

  // === 监听循环：检测说话起止 ===
  const monitor = () => {
    if (!callActiveRef.current) return;
    rafMonitorRef.current = requestAnimationFrame(monitor);
    if (speakingRef.current || mutedRef.current) {
      startFramesRef.current = 0;
      silentFramesRef.current = 0;
      return;
    }
    const rms = getRms(micAnalyserRef.current);
    if (!recordingRef.current) {
      if (rms > START_THRESH) startFramesRef.current++;
      else startFramesRef.current = 0;
      if (startFramesRef.current >= START_FRAMES) startUtterance();
    } else {
      if (rms < END_THRESH) silentFramesRef.current++;
      else silentFramesRef.current = 0;
      const elapsedUtt = performance.now() - utteranceStartRef.current;
      const frameMs = 1000 / 60;
      if (silentFramesRef.current * frameMs >= SILENCE_MS || elapsedUtt >= MAX_UTTERANCE_MS) {
        endUtterance();
      }
    }
  };

  // === 声波可视化 ===
  const draw = () => {
    if (!callActiveRef.current) return;
    rafDrawRef.current = requestAnimationFrame(draw);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const analyser = speakingRef.current ? ttsAnalyserRef.current : micAnalyserRef.current;
    const bars = Math.max(8, Math.floor(w / 7));
    const gap = 2;
    const barW = (w - gap * (bars - 1)) / bars;
    let data: Uint8Array<ArrayBuffer> | null = null;
    if (analyser) {
      data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
    }
    for (let i = 0; i < bars; i++) {
      let v = 0;
      if (data) {
        const idx = Math.floor((i / bars) * data.length * 0.7);
        v = data[idx] / 255;
      } else {
        v = 0.08 + 0.06 * Math.abs(Math.sin(Date.now() / 400 + i * 0.3));
      }
      const barH = Math.max(2, v * h);
      const x = i * (barW + gap);
      const y = (h - barH) / 2;
      ctx.fillStyle = speakingRef.current ? "#F2B03A" : "#7dd3fc";
      ctx.fillRect(x, y, barW, barH);
    }
  };

  // === 主流程：开始通话 ===
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const begin = async () => {
      setPhase("connecting");
      setSubtitle("正在接通…");
      setError(null);
      setElapsed(0);
      setYouSaid("");
      callActiveRef.current = true;

      timerRef.current = window.setInterval(() => {
        setElapsed((e) => e + 1);
      }, 1000);

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (e) {
        setError("无法访问麦克风：" + (e instanceof Error ? e.message : "权限被拒绝"));
        setSubtitle("麦克风不可用");
        callActiveRef.current = false;
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      const AudioCtxCtor =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtxCtor();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      micAnalyserRef.current = analyser;

      const mime = pickRecorderMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        handleUtteranceEnd(blob);
      };

      window.addEventListener("amadeus-tts-start", onTtsStart as EventListener);

      // 接通动画后进入聆听
      connectTimerRef.current = window.setTimeout(() => {
        if (!callActiveRef.current) return;
        setPhase("listening");
        setSubtitle("聆听中，请说话");
        rafMonitorRef.current = requestAnimationFrame(monitor);
        rafDrawRef.current = requestAnimationFrame(draw);
      }, CONNECTING_MS);
    };

    begin();

    return () => {
      cancelled = true;
      callActiveRef.current = false;
      window.clearInterval(timerRef.current);
      window.clearTimeout(connectTimerRef.current);
      window.cancelAnimationFrame(rafMonitorRef.current);
      window.cancelAnimationFrame(rafDrawRef.current);
      window.removeEventListener("amadeus-tts-start", onTtsStart as EventListener);
      stopCurrentAudio();
      speakingRef.current = false;
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {
          /* 忽略 */
        }
      }
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = !next;
      });
    }
    setSubtitle(next ? "已静音" : phase === "listening" ? "聆听中，请说话" : subtitle);
  };

  const hangUp = () => {
    callActiveRef.current = false;
    window.clearInterval(timerRef.current);
    window.clearTimeout(connectTimerRef.current);
    window.cancelAnimationFrame(rafMonitorRef.current);
    window.cancelAnimationFrame(rafDrawRef.current);
    window.removeEventListener("amadeus-tts-start", onTtsStart as EventListener);
    stopCurrentAudio();
    speakingRef.current = false;
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch {
        /* 忽略 */
      }
    }
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    window.dispatchEvent(new CustomEvent("amadeus-session-updated"));
    setPhase("ended");
    setSubtitle("通话结束");
    window.setTimeout(() => {
      onClose();
    }, 450);
  };

  if (!open) return null;

  const statusText =
    phase === "connecting"
      ? "正在接通…"
      : phase === "listening"
      ? "通话中 · 聆听中"
      : phase === "processing"
      ? "通话中 · 处理中"
      : phase === "speaking"
      ? "通话中"
      : "通话结束";

  return (
    <>
      {/* 顶部浮动通话条：不遮挡 Live2D 与聊天面板 */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-1 pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-black/70 backdrop-blur border border-white/10 shadow-lg">
          {/* 通话进行中的小绿点 */}
          <span className={`w-2 h-2 rounded-full ${phase === "connecting" ? "bg-amber-400" : "bg-green-400"} animate-pulse`} />

          <span className="text-xs font-mono text-white/90 hidden sm:inline">{character.name}</span>
          <span className="text-[11px] font-mono text-zinc-300 whitespace-nowrap">
            {statusText} · {formatTime(elapsed)}
          </span>

          {/* 声波 */}
          <canvas ref={canvasRef} width={100} height={20} className="w-[100px] h-5" />

          {/* 静音 */}
          <button
            onClick={toggleMute}
            className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors ${
              muted ? "bg-red-600/80 hover:bg-red-600" : "bg-white/15 hover:bg-white/25"
            }`}
            title={muted ? "取消静音" : "静音"}
          >
            {muted ? (
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="white" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6M3 3l18 18" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="white" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 1.5a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0v-6a3 3 0 0 0-3-3Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5a7.5 7.5 0 0 1-15 0M12 18v3.75" />
              </svg>
            )}
          </button>

          {/* 挂断 */}
          <button
            onClick={hangUp}
            className="w-7 h-7 rounded-full bg-red-600 hover:bg-red-500 flex items-center justify-center transition-colors rotate-[135deg]"
            title="挂断"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="white" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" />
            </svg>
          </button>
        </div>

        {/* 副信息：你说的话 / 错误 */}
        {(youSaid || error) && (
          <div className="pointer-events-none max-w-[80vw] px-3 py-0.5 rounded-full bg-black/60 text-[11px] font-mono text-center truncate">
            {error ? <span className="text-red-400">{error}</span> : <span className="text-zinc-300">你说：{youSaid}</span>}
          </div>
        )}
      </div>
    </>
  );
}
