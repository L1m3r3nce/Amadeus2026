/**
 * 图片存储工具：用 Tauri fs API 把图片存到硬盘
 *
 * 存储路径：$APPLOCALDATA/images/（即 AppData/Local/com.amadeus.kurisu/images/）
 * 索引文件：$APPLOCALDATA/images/index.json
 *
 * 所有 fs 调用使用相对路径 + BaseDirectory.AppLocalData，
 * 这是 Tauri 2.x fs 插件的正确用法（不能用绝对路径）。
 */

let fsModule: typeof import("@tauri-apps/plugin-fs") | null = null;

async function getFs() {
  if (!fsModule) {
    fsModule = await import("@tauri-apps/plugin-fs");
  }
  return fsModule;
}

export interface ImageRecord {
  filename: string;
  sessionId: string;
  sessionName: string;
  messageIndex: number;
  timestamp: number;
  size: number;
  width: number;
  height: number;
}

const IMAGES_DIR = "images";
const INDEX_PATH = "images/index.json";

/** 确保 images 目录存在 */
async function ensureImagesDir(): Promise<void> {
  const { mkdir, exists, BaseDirectory } = await getFs();
  if (!(await exists(IMAGES_DIR, { baseDir: BaseDirectory.AppLocalData }))) {
    await mkdir(IMAGES_DIR, { recursive: true, baseDir: BaseDirectory.AppLocalData });
  }
}

/** 保存图片到硬盘，返回图片记录 */
export async function saveImage(
  blob: Blob,
  sessionId: string,
  sessionName: string,
  messageIndex: number,
  width: number,
  height: number
): Promise<ImageRecord> {
  const fs = await getFs();
  const timestamp = Date.now();
  const filename = `${timestamp}.jpg`;
  const filepath = `${IMAGES_DIR}/${filename}`;

  // 确保目录存在
  try {
    const dirExists = await fs.exists(IMAGES_DIR, { baseDir: fs.BaseDirectory.AppLocalData });
    if (!dirExists) {
      await fs.mkdir(IMAGES_DIR, { recursive: true, baseDir: fs.BaseDirectory.AppLocalData });
    }
  } catch (e) {
    alert(`[saveImage] mkdir 失败: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }

  // 写图片文件
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await fs.writeFile(filepath, bytes, { baseDir: fs.BaseDirectory.AppLocalData });
    alert(`[saveImage] writeFile 成功: ${filepath}, ${bytes.length} bytes`);
  } catch (e) {
    alert(`[saveImage] writeFile 失败: ${filepath}, 错误: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }

  const record: ImageRecord = {
    filename,
    sessionId,
    sessionName,
    messageIndex,
    timestamp,
    size: blob.size,
    width,
    height,
  };

  // 更新索引
  try {
    await addToIndex(record);
    alert(`[saveImage] addToIndex 成功`);
  } catch (e) {
    alert(`[saveImage] addToIndex 失败: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }

  return record;
}

/** 读取索引文件 */
export async function loadIndex(): Promise<ImageRecord[]> {
  try {
    const { exists, readFile, BaseDirectory } = await getFs();
    if (!(await exists(INDEX_PATH, { baseDir: BaseDirectory.AppLocalData }))) return [];
    const content = await readFile(INDEX_PATH, { baseDir: BaseDirectory.AppLocalData });
    const text = new TextDecoder().decode(content);
    return JSON.parse(text);
  } catch {
    return [];
  }
}

/** 添加一条记录到索引 */
async function addToIndex(record: ImageRecord): Promise<void> {
  const index = await loadIndex();
  index.push(record);
  await saveIndex(index);
}

/** 保存整个索引 */
async function saveIndex(index: ImageRecord[]): Promise<void> {
  const { writeFile, BaseDirectory } = await getFs();
  await ensureImagesDir();
  const content = new TextEncoder().encode(JSON.stringify(index, null, 2));
  await writeFile(INDEX_PATH, content, { baseDir: BaseDirectory.AppLocalData });
}

/** 读取图片文件，返回 base64 data URL（用于显示） */
export async function readImageAsDataUrl(filename: string): Promise<string | null> {
  try {
    if (!filename) return null;
    const { exists, readFile, BaseDirectory } = await getFs();
    const filepath = `${IMAGES_DIR}/${filename}`;
    if (!(await exists(filepath, { baseDir: BaseDirectory.AppLocalData }))) return null;
    const bytes = await readFile(filepath, { baseDir: BaseDirectory.AppLocalData });
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

/** 读取图片文件，返回 base64（不含前缀，用于发 LLM） */
export async function readImageAsBase64(filename: string): Promise<string | null> {
  const dataUrl = await readImageAsDataUrl(filename);
  return dataUrl ? dataUrl.split(",")[1] : null;
}

/** 删除单张图片（删硬盘文件 + 索引记录） */
export async function deleteImage(filename: string): Promise<void> {
  try {
    const { exists, remove, BaseDirectory } = await getFs();
    const filepath = `${IMAGES_DIR}/${filename}`;
    if (await exists(filepath, { baseDir: BaseDirectory.AppLocalData })) {
      await remove(filepath, { baseDir: BaseDirectory.AppLocalData });
    }
  } catch { /* 忽略 */ }
  const index = await loadIndex();
  await saveIndex(index.filter((r) => r.filename !== filename));
}

/** 删除多张图片 */
export async function deleteImages(filenames: string[]): Promise<void> {
  for (const f of filenames) await deleteImage(f);
}

/** 删除全部图片 */
export async function deleteAllImages(): Promise<void> {
  const index = await loadIndex();
  const { exists, remove, BaseDirectory } = await getFs();
  for (const record of index) {
    try {
      const filepath = `${IMAGES_DIR}/${record.filename}`;
      if (await exists(filepath, { baseDir: BaseDirectory.AppLocalData })) {
        await remove(filepath, { baseDir: BaseDirectory.AppLocalData });
      }
    } catch { /* 忽略 */ }
  }
  await saveIndex([]);
}

/** 获取图片统计信息 */
export async function getImageStats(): Promise<{ count: number; totalSize: number }> {
  const index = await loadIndex();
  return {
    count: index.length,
    totalSize: index.reduce((sum, r) => sum + r.size, 0),
  };
}

/** 检查图片文件是否存在 */
export async function imageExists(filename: string): Promise<boolean> {
  if (!filename) return false;
  try {
    const { exists, BaseDirectory } = await getFs();
    return await exists(`${IMAGES_DIR}/${filename}`, { baseDir: BaseDirectory.AppLocalData });
  } catch {
    return false;
  }
}
