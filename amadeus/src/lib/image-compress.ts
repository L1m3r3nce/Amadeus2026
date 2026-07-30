/**
 * 图片压缩工具：发送前把图片缩到 1024x1024 以内，转 JPEG
 * 减少 base64 体积，加快 LLM 处理速度
 */

const MAX_SIZE = 1024;
const QUALITY = 0.85;

export interface CompressedImage {
  blob: Blob;
  base64: string;   // 不含 data:image/xxx;base64, 前缀（用于发 LLM）
  dataUrl: string;  // 完整 data URL（用于预览）
  width: number;
  height: number;
  size: number;     // 字节数
}

/**
 * 压缩图片：缩放到 1024x1024 以内，转 JPEG
 * 支持 File（文件选择/拖拽）或 Blob（粘贴）
 */
export async function compressImage(file: File | Blob): Promise<CompressedImage> {
  const bitmap = await createImageBitmap(file);

  // 计算缩放比例（只缩小不放大）
  let width = bitmap.width;
  let height = bitmap.height;
  if (width > MAX_SIZE || height > MAX_SIZE) {
    const ratio = Math.min(MAX_SIZE / width, MAX_SIZE / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  // 用 Canvas 绘制并压缩
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, width, height);

  // 转 JPEG blob（用于存硬盘）
  const blob: Blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b!), "image/jpeg", QUALITY);
  });

  // 转 data URL（用于预览和发 LLM）
  const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
  const base64 = dataUrl.split(",")[1];

  // 释放 bitmap
  bitmap.close?.();

  return { blob, base64, dataUrl, width, height, size: blob.size };
}
