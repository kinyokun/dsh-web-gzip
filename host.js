/**
 * dsh-web-gzip — DSH 宿主插件：给 dsh web 的 HTTP 响应加透明 gzip 压缩。
 *
 * 解决什么问题：DeepSeek Harness 的 Web 栈（dsh-host-webserver / dsh-client-connection）
 * 默认不做 HTTP 压缩，而 session.history 一页可能携带数 MB 的裸 JSON（包含大量
 * assistant/chunk 流式增量事件）。公网远程访问时这些裸 JSON 就是「会话记录加载慢」
 * 的主因——文本类内容 gzip 压缩率约 10:1，实测 12.6 MB 的一页历史压缩到 1.06 MB。
 *
 * ── 与 DSH 0.2.x 的兼容（v2.0.0） ────────────────────────────────────
 * DSH 0.2.0 起 webServer 的路由模型扩展成两种形态：
 *   - handler 路由：{ kind, path, handler(req, res) }  —— 直接持有 node 响应
 *   - resource 路由：{ kind, path, resource(request, peer) } —— Fetch 语义
 * 并且 SPA 的 fallback 席位也改成 { resource }（不再是裸 handler）。
 * v1.x 只认 route.handler / function fallback，会把 { resource } 当成函数调用，
 * 于是每个请求都以 TypeError 收场（HTTP 400）。v2 按形态分别包装：
 *   - handler：缓冲响应体，end() 时决定压缩或透传（无法预知 content-type）；
 *   - resource：对 Fetch Response 用 CompressionStream 流式压缩，不整体缓冲，
 *     且只在真实 HTTP 交换（peer === undefined）时压缩，readResource 进程内
 *     读取保持原始字节。
 *
 * 另外 DSH 0.2.0 的 WebServer 自带 compression: gzip 配置（listener 级中间件）。
 * 若宿主已开启，本插件自动让位（不重复编码、不再缓冲），只留一条日志。
 *
 * HTTP 语义：压缩时移除 content-length、添加 content-encoding: gzip 与
 * vary: accept-encoding（合并已有 vary 值）；不带 Accept-Encoding 的客户端
 * 收到的响应与未安装本插件时逐字节一致。
 * 透传：HEAD / Range、SSE、已带 content-encoding、zip / octet-stream / 图片 /
 * 音视频 / 字体 / wasm、小于 MIN_BODY_BYTES、204 / 304。
 *
 * 生命周期：所有副作用归属于当前 Fiber，插件禁用/卸载时 disposer 完整还原
 * 原始 responder 与 register / registerFallback，无残留。
 *
 * 依赖：仅 node:zlib 与 Web 标准 CompressionStream（Node 20+ 内置），
 * 零运行时依赖。不碰业务逻辑、会话数据与磁盘文件。
 */

import { createGzip } from "node:zlib";

export const name = "dsh-web-gzip";
export const inject = ["webServer"];
export const version = "2.0.0";

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

const isSkippedType = (contentType) =>
  SKIP_CONTENT_TYPES.some((type) => contentType.toLowerCase().includes(type));

/** 合并 vary：已有 accept-encoding 就原样保留，否则追加。 */
function mergeVary(existing) {
  const value = String(existing ?? "");
  if (/accept-encoding/i.test(value)) return value;
  return value ? value + ", accept-encoding" : "accept-encoding";
}

// ── handler 路由：缓冲响应体，end() 时决定压缩或透传 ──────────────────
/**
 * 把一个 node 风格 handler 包装成「缓冲响应体 → 按需 gzip」的 handler。
 * 拦截 writeHead / write / end / flushHeaders：先把响应头与响应体吞进缓冲区，
 * 直到 end() 时才决定压缩或透传。调用 flushHeaders 视为流式响应，立即透传。
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
    const rawFlushHeaders = typeof res.flushHeaders === "function" ? res.flushHeaders.bind(res) : undefined;

    const chunks = [];
    let statusCode = res.statusCode ?? 200;
    let statusMessage = res.statusMessage;
    let wroteHead = false;
    let passthrough = false;

    const shouldPassthrough = () =>
      isSkippedType(String(res.getHeader("content-type") ?? "")) ||
      res.getHeader("content-encoding") !== undefined;

    /** 已缓冲的字节先冲出去，之后进入透传模式。 */
    const flushRaw = () => {
      passthrough = true;
      if (chunks.length > 0) {
        const pre = Buffer.concat(chunks);
        chunks.length = 0;
        rawWriteHead(statusCode, statusMessage);
        wroteHead = true;
        rawWrite(pre);
      }
    };

    // 推迟真实 writeHead：先吞掉 header 与 body，end() 时再决定压缩与否
    res.flushHeaders = () => {
      if (passthrough) return rawFlushHeaders ? rawFlushHeaders() : res;
      flushRaw();
      return rawFlushHeaders ? rawFlushHeaders() : res;
    };
    res.writeHead = function (sc, sm, hd) {
      if (typeof sm === "object" && hd === undefined) {
        hd = sm;
        sm = undefined;
      }
      statusCode = sc;
      statusMessage = sm;
      wroteHead = true;
      if (hd && typeof hd === "object") {
        for (const key of Object.keys(hd)) res.setHeader(key, hd[key]);
      }
      if (passthrough) {
        rawWriteHead(sc, sm);
      } else if (shouldPassthrough()) {
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
      // 兜底：handler 未调用 writeHead 而是 setHeader/statusCode + end 时同样生效
      if (!passthrough && shouldPassthrough()) flushRaw();
      if (passthrough) return rawEnd(chunk, enc, cb);
      if (chunk !== undefined && chunk !== null) chunks.push(toBuffer(chunk, enc));
      if (!wroteHead) {
        // handler 直接写 res.statusCode 时以它为准（204/304 判断依赖真实状态码）
        statusCode = res.statusCode ?? statusCode;
        statusMessage = res.statusMessage ?? statusMessage;
      }
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
        res.setHeader("vary", mergeVary(res.getHeader("vary")));
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

const supportsCompressionStream = typeof CompressionStream === "function";

/**
 * 把一个 Fetch 语义 resource 包装成「Response 按需流式 gzip」。
 * 只在真实 HTTP 交换时压缩：http 分派调用 resource(request)（peer 为 undefined），
 * 而 webServer.readResource 会传 peer —— 进程内读取必须返回原始字节。
 *
 * @param {Function} resource 原始 (request, peer?) => Promise<Response>
 * @returns {Function} 包装后的 resource
 */
function wrapResource(resource) {
  return async function gzipResource(request, peer) {
    const response = await resource(request, peer);
    if (peer !== undefined || !supportsCompressionStream) return response;
    return compressResponse(response, request);
  };
}

/** 按响应头与请求头决定是否流式压缩一个 Fetch Response。 */
function compressResponse(response, request) {
  if (request.method === "HEAD") return response;
  if (request.headers.get("range") !== null) return response;
  if (!/\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "")) return response;
  if (!response.body || response.status === 204 || response.status === 304) return response;
  if (isSkippedType(response.headers.get("content-type") ?? "")) return response;
  if (response.headers.get("content-encoding") !== null) return response;
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 0 && length < MIN_BODY_BYTES) return response;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-encoding", "gzip");
  headers.set("vary", mergeVary(headers.get("vary")));
  const body = response.body.pipeThrough(new CompressionStream("gzip"));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** 按路由形态包装：resource 路由保持 resource 字段，handler 路由保持 handler 字段。 */
function wrapRouteShape(route) {
  if ("resource" in route && route.resource !== undefined) {
    return { ...route, resource: wrapResource(route.resource) };
  }
  return { ...route, handler: wrapHandler(route.handler) };
}

/**
 * 宿主侧入口：包装 webServer 的全部路由与 fallback，并接管注册方法。
 * 返回 disposer，插件卸载时完整还原。
 *
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  const ws = ctx.webServer;

  // DSH 0.2.0+ 的 webServer 自带 gzip 中间件；开着就别重复压缩、也别再缓冲。
  if (ws.config?.compression === "gzip" || ws.gzip !== undefined) {
    ctx.logger?.info?.("dsh-web-gzip: 宿主已启用内置 gzip（webServer.compression），插件让位");
    return () => {};
  }

  const originals = new Map(); // wrapped route -> { handler } | { resource }

  const wrapExisting = (route) => {
    if (originals.has(route)) return;
    if ("resource" in route && route.resource !== undefined) {
      originals.set(route, { resource: route.resource });
      route.resource = wrapResource(route.resource);
    } else {
      originals.set(route, { handler: route.handler });
      route.handler = wrapHandler(route.handler);
    }
  };

  for (const route of ws.exact.values()) wrapExisting(route);
  for (const route of ws.prefixes.values()) wrapExisting(route);

  let originalFallback;
  const hadFallback = ws.fallback !== undefined;
  if (hadFallback) {
    originalFallback = ws.fallback;
    ws.fallback =
      typeof originalFallback === "function"
        ? wrapHandler(originalFallback)
        : { resource: wrapResource(originalFallback.resource) };
  }

  const originalRegister = ws.register.bind(ws);
  const originalRegisterFallback = ws.registerFallback.bind(ws);
  ws.register = (route) => originalRegister(wrapRouteShape(route));
  ws.registerFallback = (fallback) =>
    originalRegisterFallback(
      typeof fallback === "function" ? wrapHandler(fallback) : { resource: wrapResource(fallback.resource) },
    );

  return () => {
    ws.register = originalRegister;
    ws.registerFallback = originalRegisterFallback;
    for (const [route, original] of originals) {
      if ("resource" in original) route.resource = original.resource;
      else route.handler = original.handler;
    }
    originals.clear();
    if (hadFallback) ws.fallback = originalFallback;
  };
}
