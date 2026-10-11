import { NextRequest, NextResponse } from "next/server";

/**
 * 本地服务访问令牌（防止本机其他进程滥用本地 API）
 *
 * 背景：应用运行时在本机 127.0.0.1:3456 提供 HTTP 服务，且 API 未鉴权。
 * 虽然只监听回环地址、局域网不可达，但同一台机器上的任何进程都可以直接
 * 调用 /api/*（例如借你配置的 Key 消耗 LLM 配额、探测服务是否存在）。
 *
 * 机制：
 * - Tauri（Rust 侧）每次启动 sidecar 时生成随机 token，通过环境变量
 *   AMADEUS_TOKEN 传给 Node 服务，并在 webview 首载 URL 上带 ?token=...
 * - 本代理层校验首载 URL 的 token，通过后写入 httpOnly cookie 并重定向到
 *   不带 token 的干净 URL；此后页面与 /api/* 请求凭 cookie 访问
 * - cookie 为 httpOnly + SameSite=Strict，页面脚本读不到，跨站请求带不上
 * - 未设置 AMADEUS_TOKEN（npm run dev / 裸跑 next start 的开发场景）时
 *   全部放行，不影响开发
 */
export function proxy(req: NextRequest) {
  // 在函数内读取，确保取到的是运行时环境变量而不是构建时的值
  const token = process.env.AMADEUS_TOKEN;
  if (!token) return NextResponse.next();

  const url = req.nextUrl;

  // 首载：URL 带正确 token → 换发 httpOnly cookie，并从地址栏去掉 token
  if (url.searchParams.get("token") === token) {
    const clean = new URL(url.toString());
    clean.searchParams.delete("token");
    const res = NextResponse.redirect(clean);
    res.cookies.set("amadeus_token", token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    return res;
  }

  const authorized = req.cookies.get("amadeus_token")?.value === token;

  if (url.pathname.startsWith("/api/")) {
    if (authorized) return NextResponse.next();
    return NextResponse.json({ error: "未授权的本地请求" }, { status: 403 });
  }

  if (authorized) return NextResponse.next();
  return new NextResponse("Forbidden", { status: 403 });
}

export const config = {
  // 覆盖页面与 API；_next/image 不经过（本项目未用图片优化器）
  matcher: ["/((?!_next/image).*)"],
};
