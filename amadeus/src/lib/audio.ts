/**
 * 音频工具：解码录音 Blob、编码 16-bit PCM WAV、Blob → base64 dataURL。
 * MiMo ASR 只接受 mp3 / wav 的 data URL，浏览器 MediaRecorder 产出的 webm/ogg
 * 需要转成 wav 再上传，所以这里统一做编码。
 */

/** 用 Web Audio API 解码一个音频 Blob（webm/ogg/wav 均可，依赖浏览器解码能力）。 */
export async function decodeAudioBlob(blob: Blob, audioCtx: AudioContext): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  // decodeAudioData 在部分浏览器是回调式，这里用 Promise 包裹保证兼容
  return await new Promise<AudioBuffer>((resolve, reject) => {
    audioCtx.decodeAudioData(
      arrayBuffer,
      (buf) => resolve(buf),
      (err) => reject(err),
    );
  });
}

/**
 * 把 AudioBuffer 编码成 16-bit PCM 单声道 WAV Blob。
 * 下混为单声道、保留原始采样率（ASR 后端会自行重采样），文件小且格式正确。
 */
export function encodeWav(audioBuffer: AudioBuffer): Blob {
  const numChannels = 1;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;

  // 下混到单声道
  const mono = new Float32Array(length);
  if (audioBuffer.numberOfChannels === 1) {
    mono.set(audioBuffer.getChannelData(0));
  } else {
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const ch = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += ch[i];
    }
    for (let i = 0; i < length; i++) mono[i] /= audioBuffer.numberOfChannels;
  }

  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk 大小
  view.setUint16(20, 1, true); // 音频格式 = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    let s = Math.max(-1, Math.min(1, mono[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, s, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/** Blob → base64 dataURL（用于作为 ASR 请求体的音频字段）。 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Blob 转 dataURL 失败"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 选一个浏览器支持的 MediaRecorder MIME（优先 webm/opus，再退 ogg，最后交默认）。
 * MiMo ASR 只认 wav/mp3，所以录制完要用 encodeWav 转码，这里只是选个能录的格式。
 */
export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}
