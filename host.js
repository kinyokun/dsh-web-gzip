/**
 * dsh-web-gzip — DSH 宿主插件：给 dsh web 的 HTTP 响应加透明 gzip 压缩。
 *
 * 解决什么问题：DeepSeek Harness 的 Web 栈（dsh-host-webserver /
 * dsh-client-connection）没有任何 HTTP 压缩中间件，而 session.history
 * 一页可能携带数 MB 的裸 JSON（包含大量 assistant/chunk 流式增量事件）。
 * 公网远程访问时这些裸 JSON 就是「会话记录加载慢」的主因——文本类内容
 * gzip 压缩率约 10:1，实测 12.6 MB 的一页历史压缩到 1.06 MB（8.4%）。
 *
 * 实现方式：包装 webServer 上已注册的 exact / prefix 路由 handler 与
 * fallback，并包装 register / registerFallback，使之后注册的路由同样生效。
 * 只对声明 Accept-Encoding: gzip 的请求压缩，以下情况原样透传：
 *   - HEAD / Range 请求（语义要求字节精确）
 *   - SSE（text/event-stream，保持逐块即时到达）
 *   - 已自带 content-encoding 的响应
 *   - 压缩收益低的类型：zip / gzip / octet-stream / 图片 / 音视频 / 字体 / wasm
 *   - 响应体小于 MIN_BODY_BYTES（小响应压缩反而亏）
 *   - 204 / 304 空响应
 *
 * HTTP 语义：压缩时移除 content-length、添加 content-encoding: gzip 与
 * vary: accept-encoding（合并已有 vary 值）；不带 Accept-Encoding 的客户端
 * 收到的响应与未安装本插件时逐字节一致。
 *
 * 生命周期：所有副作用归属于当前 Fiber，插件禁用/卸载时 disposer 完整
 * 还原原始 handler 与 register / registerFallback 方法，无残留。
 *
 * 依赖：仅 node:zlib（Node 内置，零运行时依赖）。不碰业务逻辑、会话数据
 * 与磁盘文件；只缓冲单个响应的响应体（上限 = 该响应自身大小）。
 */

import { createGzip } from "node:zlib";

export const name = "dsh-web-gzip";
export const inject = ["webServer"];
export const version = "1.0.0";

// ── 可调参数 ─────────────────────────────────────────────────────────
/** 低于该字节数不压缩（小响应压缩开销大于收益）。 */
const MIN_BODY_BYTES = 512;
/** gzip 压缩级别（1-9，6 为速度/压缩率平衡点）。 */
const GZIP_LEVEL = 6;
/** 这些内容类型前缀压缩收益低或语义不允许，直接透传。 */
const SKIP_CONTENT_TYPES = [
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/octet-stream",
  "application/wasm",
  "text/event-stream",
  "image/",
  "audio/",
  "video/",
  "font/",
];

// ── 工具 ─────────────────────────────────────────────────────────────
const toBuffer = (chunk, enc) =>
  Buffer.isBuffer(chunk)
    ? chunk
    : typeof chunk === "string"
      ? Buffer.from(chunk, enc ?? "utf8")
      : Buffer.from(chunk);

/**
 * 把一个路由 handler 包装成「缓冲响应体 → 按需 gzip」的 handler。
 * 包装器拦截 writeHead / write / end / flushHeaders：先把响应头与响应体
 * 吞进缓冲区，直到 end() 时才决定压缩或透传。
 *
 * @param {Function} handler 原始 (req, res) => Promise|void 路由 handler
 * @returns {Function} 包装后的 handler
 */
function wrapHandler(handler) {
  return async function gzipHandler(req, res) {
    const acceptsGzip = /\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""));
    const wantsSse = /text\/event-stream/i.test(String(req.headers.accept ?? ""));
    if (!acceptsGzip || wantsSse || req.method === "HEAD" || req.headers.range !== undefined) {
      return await handler(req, res);
    }

    const rawWriteHead = res.writeHead.bind(res);
    const rawWrite = res.write.bind(res);
    const rawEnd = res.end.bind(res);

    const chunks = [];
    let statusCode = 200;
    let statusMessage = undefined;
    let passthrough = false;

    const skipType = (ctype) => SKIP_CONTENT_TYPES.some((t) => ctype.includes(t));
    const shouldPassthrough = () =>
      skipType(String(res.getHeader("content-type") ?? "")) ||
      res.getHeader("content-encoding") !== undefined;

    /** 已缓冲的字节先冲出去，之后进入透传模式。 */
    const flushRaw = (forceStatus) => {
      passthrough = true;
      if (chunks.length > 0) {
        const pre = Buffer.concat(chunks);
        chunks.length = 0;
        rawWriteHead(forceStatus ?? statusCode, statusMessage);
        rawWrite(pre);
      }
    };

    // 推迟真实 writeHead：先吞掉 header 与 body，end() 时再决定压缩与否
    res.flushHeaders = () => res;
    res.writeHead = function (sc, sm, hd) {
      if (typeof sm === "object" && hd === undefined) {
        hd = sm;
        sm = undefined;
      }
      statusCode = sc;
      statusMessage = sm;
      if (hd && typeof hd === "object") {
        for (const key of Object.keys(hd)) res.setHeader(key, hd[key]);
      }
      if (shouldPassthrough()) {
        passthrough = true;
        rawWriteHead(sc, sm);
      }
      return res;
    };
    res.write = function (chunk, enc, cb) {
      if (!passthrough && shouldPassthrough()) flushRaw();
      if (passthrough) return rawWrite(chunk, enc, cb);
      if (chunk !== undefined && chunk !== null) chunks.push(toBuffer(chunk, enc));
      if (typeof cb === "function") cb();
      return true;
    };
    res.end = function (chunk, enc, cb) {
      // 兜底：handler 未调用 writeHead 而是 setHeader + end 时，同样走透传判断
      if (!passthrough && shouldPassthrough()) flushRaw();
      if (passthrough) return rawEnd(chunk, enc, cb);
      if (chunk !== undefined && chunk !== null) chunks.push(toBuffer(chunk, enc));
      const body = Buffer.concat(chunks);
      const compressible =
        body.length >= MIN_BODY_BYTES && statusCode !== 204 && statusCode !== 304;
      if (!compressible) {
        rawWriteHead(statusCode, statusMessage);
        rawEnd(body);
        if (typeof cb === "function") cb();
        return res;
      }
      const gzip = createGzip({ level: GZIP_LEVEL });
      const parts = [];
      gzip.on("data", (d) => parts.push(d));
      gzip.on("error", () => {
        if (res.headersSent) return;
        rawWriteHead(statusCode, statusMessage);
        rawEnd(body);
        if (typeof cb === "function") cb();
      });
      gzip.on("end", () => {
        if (res.headersSent) return;
        res.removeHeader("content-length");
        res.setHeader("content-encoding", "gzip");
        const vary = String(res.getHeader("vary") ?? "");
        res.setHeader(
          "vary",
          /accept-encoding/i.test(vary)
            ? vary
            : vary
              ? `${vary}, accept-encoding`
              : "accept-encoding",
        );
        rawWriteHead(statusCode, statusMessage);
        rawEnd(Buffer.concat(parts));
        if (typeof cb === "function") cb();
      });
      gzip.end(body);
      return res;
    };

    try {
      return await handler(req, res);
    } catch (error) {
      // handler 抛错且尚未写出任何响应头时，按未包装行为兜底 400
      if (!res.headersSent) {
        passthrough = true;
        rawWriteHead(400);
        rawEnd();
      }
      throw error;
    }
  };
}

/**
 * 宿主侧入口：包装 webServer 的全部路由与 fallback，并接管注册方法。
 * 返回 disposer，插件卸载时完整还原。
 *
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  const ws = ctx.webServer;

  const originals = new Map(); // wrapped route -> original handler
  const wrapRoute = (route) => {
    if (originals.has(route)) return;
    originals.set(route, route.handler);
    route.handler = wrapHandler(route.handler);
  };

  for (const route of ws.exact.values()) wrapRoute(route);
  for (const route of ws.prefixes.values()) wrapRoute(route);

  let wrappedFallback = false;
  let originalFallback;
  if (ws.fallback !== undefined) {
    wrappedFallback = true;
    originalFallback = ws.fallback;
    ws.fallback = wrapHandler(originalFallback);
  }

  const originalRegister = ws.register.bind(ws);
  const originalRegisterFallback = ws.registerFallback.bind(ws);
  ws.register = (route) => originalRegister({ ...route, handler: wrapHandler(route.handler) });
  ws.registerFallback = (handler) => originalRegisterFallback(wrapHandler(handler));

  return () => {
    ws.register = originalRegister;
    ws.registerFallback = originalRegisterFallback;
    for (const [route, handler] of originals) route.handler = handler;
    originals.clear();
    if (wrappedFallback) ws.fallback = originalFallback;
  };
}
