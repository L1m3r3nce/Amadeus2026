/**
 * 流式 vs 非流式 延迟对比测试 —— 完全绕过 Next.js
 *
 * 用法：
 *   node scripts/test-stream-latency.mjs <endpoint> <apiKey> <model>
 *   node scripts/test-stream-latency.mjs   # 然后按提示输入
 *
 * 对比同一请求的：
 *   - 非流式：fetch返回 → JSON解析完成（首字延迟 = 总生成时间）
 *   - 流式：fetch返回 → 首个 delta 到达（首字延迟 ≈ 模型开始输出时间）
 */
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

async function testNonStream(endpoint, apiKey, model) {
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: "你是牧濑红莉栖，简短回复。" },
      { role: "user", content: "你好，今天怎么样？" },
    ],
    max_tokens: 200,
  });

  const t0 = Date.now();
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body,
  });
  const fetchMs = Date.now() - t0;
  const data = await res.json();
  const totalMs = Date.now() - t0;
  const content = data.choices?.[0]?.message?.content || "";
  console.log(`  [非流式] fetch返回: ${fetchMs}ms | 总耗时(首字=总): ${totalMs}ms | 字符: ${content.length}`);
  return { fetchMs, totalMs, chars: content.length };
}

async function testStream(endpoint, apiKey, model) {
  const body = JSON.stringify({
    model,
    stream: true,
    messages: [
      { role: "system", content: "你是牧濑红莉栖，简短回复。" },
      { role: "user", content: "你好，今天怎么样？" },
    ],
    max_tokens: 200,
  });

  const t0 = Date.now();
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body,
  });
  const fetchMs = Date.now() - t0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenMs = 0;
  let totalChars = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          if (firstTokenMs === 0) firstTokenMs = Date.now() - t0;
          totalChars += delta.length;
        }
      } catch { /* 忽略 */ }
    }
  }
  const totalMs = Date.now() - t0;
  console.log(`  [流式]   fetch返回: ${fetchMs}ms | 首字: ${firstTokenMs}ms | 总耗时: ${totalMs}ms | 字符: ${totalChars}`);
  return { fetchMs, firstTokenMs, totalMs, chars: totalChars };
}

async function main() {
  console.log("=== 流式 vs 非流式 延迟对比测试 ===\n");

  let endpoint = process.argv[2] || await ask("Endpoint (如 https://api.xiaomimimo.com/v1): ");
  let apiKey = process.argv[3] || await ask("API Key: ");
  let model = process.argv[4] || await ask("Model (如 mimo-v2.5-pro): ");

  endpoint = endpoint.trim();
  apiKey = apiKey.trim();
  model = model.trim();

  console.log(`\n配置: endpoint=${endpoint}, model=${model}, key=***${apiKey.slice(-4)}\n`);

  for (let i = 1; i <= 3; i++) {
    console.log(`--- 第 ${i} 轮 ---`);
    console.log("测试非流式...");
    await testNonStream(endpoint, apiKey, model);
    console.log("测试流式...");
    await testStream(endpoint, apiKey, model);
    console.log("");
  }

  console.log("=== 结论 ===");
  console.log("流式首字 < 3s → 正常，改回流式后体感延迟会大幅降低");
  console.log("流式首字 > 8s → MiMo 当前确实慢（限流/高峰），代码无能为力，等恢复");
  console.log("流式 fetch返回 异常大(>5s) → 网络/握手问题");

  rl.close();
}

main();
