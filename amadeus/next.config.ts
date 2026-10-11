import type { NextConfig } from "next";

// 内容安全策略：只允许同源资源。
// - script/style 需要 'unsafe-inline'：Next.js App Router 的水合引导脚本和
//   Tailwind 注入的样式是内联的；'wasm-unsafe-eval' 兜底 Live2D Cubism Core
//   可能使用的 WebAssembly。
// - connect-src 'self'：前端只与本机服务通信，出站 LLM/TTS 请求全部由
//   /api/* 服务端代理，页面脚本无法把数据发往任意外部地址。
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // standalone 模式：next build 生成 .next/standalone 目录，
  // 包含可独立运行的 server.js + 精简的 node_modules（只含实际用到的依赖）。
  // Tauri 打包时把这个目录 + node.exe + public 一起塞进安装包，
  // 运行时由 Tauri 静默启动 node server.js，用户只看到一个应用窗口。
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
