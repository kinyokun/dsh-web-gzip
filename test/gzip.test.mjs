/**
 * dsh-web-gzip 测试套件。
 *
 * 用 mock webServer（DSH 0.2.x 形态：handler 路由 + resource 路由 + 两种 fallback）
 * 与真实 node:http 服务器做字节级断言。
 * 注意：必须使用 http.request + agent:false——undici fetch 会自动解压 gzip
 * 却保留 content-encoding 头，会造成"已解压但仍带 gzip 头"的假象。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";

// 被测插件（apply + name + inject + version）
const plugin = await import("../host.js");
assert.equal(plugin.name, "dsh-web-gzip");
assert.deepEqual(plugin.inject, ["webServer"]);
assert.equal(plugin.version, "2.0.0");

/**
 * mock webServer：结构与 dsh-host-webserver 0.2.x 一致
 * （exact/prefixes Map、fallback 可为 handler 或 {resource}、register 返回 disposer）。
 */
function makeWebServer(extra = {}) {
  const ws = {
    exact: new Map(),
    prefixes: new Map(),
    fallback: undefined,
    config: { compression: "none" },
    register(route) {
      const table = route.kind === "prefix" ? ws.prefixes : ws.exact;
      table.set(route.path, route);
      return () => table.delete(route.path);
    },
    registerFallback(fallback) {
      if (ws.fallback !== undefined) throw new Error("fallback already registered");
      ws.fallback = fallback;
      return () => {
        ws.fallback = undefined;
      };
    },
    ...extra,
  };
  return ws;
}

/** 生成约 270 KB 的高度重复 JSON（模拟 session.history 的 chunk 事件流）。 */
function bigJson() {
  return JSON.stringify(
    Array.from({ length: 3000 }, (_, i) => ({
      id: i,
      type: "assistant/chunk",
      role: "assistant",
      text: "stream chunk " + i + " " + "x".repeat(80),
    })),
  );
}

/** 一个约 270 KB 的 HTML 响应（模拟 SPA index / 静态资源）。 */
function htmlResponse(body = bigJson()) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "content-length": String(Buffer.byteLength(body)) },
  });
}

/** 把 Fetch Response 写到 node 响应上（与 dsh-host-webserver 的 writeResponse 语义一致）。 */
async function writeFetchResponse(res, response) {
  const headers = Object.fromEntries(response.headers);
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of Readable.fromWeb(response.body)) res.write(chunk);
  res.end();
}

/** 起一个把 ws 当前路由状态接入 http 的服务器（每次请求实时读 ws，避免陈旧闭包）。 */
async function listen(ws) {
  const server = http.createServer(async (req, res) => {
    const target = new URL(req.url, "http://x");
    const route =
      ws.exact.get(target.pathname) ??
      [...ws.prefixes].find(([p]) => target.pathname === p || target.pathname.startsWith(p + "/"))?.[1];
    const responder = route ?? ws.fallback;
    if (responder === undefined) {
      res.writeHead(404);
      res.end("nf");
      return;
    }
    try {
      if (typeof responder === "function") await responder(req, res);
      else if ("resource" in responder)
        await writeFetchResponse(
          res,
          await responder.resource(new Request(target, { method: req.method, headers: Object.entries(req.headers) })),
        );
      else await responder.handler(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    port,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** 原始字节请求（agent:false，保留压缩态响应体）。 */
function rawRequest(port, { path = "/", method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** 简化入口：给 ws 装一个 handler → 应用插件 → 起服务器 → 发请求 → 收摊。 */
async function serve(handler, { fallback, apply = true, headers = gzipHeaders, method = "GET", path = "/", ws: existingWs } = {}) {
  const ws = existingWs ?? makeWebServer();
  ws.exact.set(path, { kind: "exact", path, handler });
  let dispose;
  if (apply) dispose = plugin.apply({ webServer: ws });
  const { port, close } = await listen(ws);
  const res = await rawRequest(port, { path, method, headers });
  await close();
  return { ws, res, dispose, port };
}

/** 简化入口：给 ws 装一个 resource 路由。 */
async function serveResource(resource, { headers = gzipHeaders, method = "GET", path = "/r" } = {}) {
  const ws = makeWebServer();
  ws.exact.set(path, { kind: "exact", path, resource });
  const dispose = plugin.apply({ webServer: ws });
  const { port, close } = await listen(ws);
  const res = await rawRequest(port, { path, method, headers });
  await close();
  dispose();
  return { ws, res };
}

const BODY = bigJson();
const gzipHeaders = { "accept-encoding": "gzip" };

test("gzip 往返：大 JSON 被压缩且可还原", async () => {
  const { res } = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(BODY);
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-encoding"], "gzip");
  assert.equal(res.headers["content-length"], undefined);
  assert.equal(res.headers.vary, "accept-encoding");
  assert.deepEqual(gunzipSync(res.body), Buffer.from(BODY));
});

test("压缩率：重复 JSON 应压到 12% 以下", async () => {
  const { res } = await serve((req, res) => res.end(BODY));
  assert.ok(res.body.length / BODY.length < 0.12, "ratio=" + (res.body.length / BODY.length).toFixed(3));
});

test("非 gzip 客户端：响应逐字节一致", async () => {
  const { res } = await serve(
    (req, res) => res.end(BODY),
    { headers: {} },
  );
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.headers["content-length"], String(BODY.length));
  assert.deepEqual(res.body, Buffer.from(BODY));
});

test("handler 直接写 res.statusCode 时保留真实状态码", async () => {
  const { res } = await serve((req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false }));
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.toString(), JSON.stringify({ ok: false }));
});

test("SSE（text/event-stream）透传不缓冲", async () => {
  let flushed = false;
  const { res } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: hello\n\n");
    res.flushHeaders();
    flushed = true;
    res.write("data: world\n\n");
    res.end();
  });
  assert.equal(flushed, true);
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.body.toString(), "data: hello\n\ndata: world\n\n");
});

test("zip 内容类型透传", async () => {
  const zip = Buffer.alloc(64 * 1024, 7);
  const { res } = await serve((req, res) => {
    res.setHeader("content-type", "application/zip");
    res.end(zip);
  });
  assert.equal(res.headers["content-encoding"], undefined);
  assert.deepEqual(res.body, zip);
});

test("octet-stream 透传", async () => {
  const blob = Buffer.alloc(64 * 1024, 3);
  const { res } = await serve((req, res) => {
    res.setHeader("content-type", "application/octet-stream");
    res.end(blob);
  });
  assert.equal(res.headers["content-encoding"], undefined);
  assert.deepEqual(res.body, blob);
});

test("图片透传", async () => {
  const img = Buffer.alloc(32 * 1024, 9);
  const { res } = await serve((req, res) => {
    res.setHeader("content-type", "image/png");
    res.end(img);
  });
  assert.equal(res.headers["content-encoding"], undefined);
  assert.deepEqual(res.body, img);
});

test("小响应透传且保留显式 content-length", async () => {
  const small = "short";
  const { res } = await serve((req, res) => {
    res.setHeader("content-length", String(Buffer.byteLength(small)));
    res.end(small);
  });
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.headers["content-length"], String(Buffer.byteLength(small)));
  assert.equal(res.body.toString(), small);
});

test("HEAD 请求透传", async () => {
  const { res } = await serve((req, res) => res.end(BODY), { headers: gzipHeaders, method: "HEAD" });
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.body.length, 0);
});

test("Range 请求透传", async () => {
  const { res } = await serve((req, res) => res.end(BODY), { headers: { range: "bytes=0-99" } });
  assert.equal(res.headers["content-encoding"], undefined);
});

test("204 空响应不压缩", async () => {
  const { res } = await serve((req, res) => { res.writeHead(204); res.end(); });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["content-encoding"], undefined);
});

test("304 不压缩", async () => {
  const { res } = await serve((req, res) => { res.writeHead(304); res.end(); });
  assert.equal(res.statusCode, 304);
  assert.equal(res.headers["content-encoding"], undefined);
});

test("已自带 content-encoding 的响应透传", async () => {
  const { res } = await serve((req, res) => {
    res.setHeader("content-encoding", "br");
    res.end(BODY);
  });
  assert.equal(res.headers["content-encoding"], "br");
});

test("vary 合并：已有值追加 accept-encoding", async () => {
  const { res } = await serve((req, res) => {
    res.setHeader("vary", "origin");
    res.end(BODY);
  });
  assert.equal(res.headers.vary, "origin, accept-encoding");
});

test("handler 抛错且未写响应头时兜底 400", async () => {
  const { res } = await serve(async () => {
    throw new Error("boom");
  });
  assert.equal(res.statusCode, 400);
});

test("apply 之后 register 的路由同样被压缩", async () => {
  const ws = makeWebServer();
  const dispose = plugin.apply({ webServer: ws });
  ws.register({ kind: "exact", path: "/late", handler: (req, res) => res.end(BODY) });
  const { port, close } = await listen(ws);
  const res = await rawRequest(port, { path: "/late", headers: gzipHeaders });
  await close();
  dispose();
  assert.equal(res.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(res.body), Buffer.from(BODY));
});

test("apply 之后 registerFallback 同样被压缩", async () => {
  const ws = makeWebServer();
  const dispose = plugin.apply({ webServer: ws });
  ws.registerFallback((req, res) => res.end(BODY));
  const { port, close } = await listen(ws);
  const res = await rawRequest(port, { path: "/anything", headers: gzipHeaders });
  await close();
  dispose();
  assert.equal(res.headers["content-encoding"], "gzip");
});

test("已有 fallback 被包装", async () => {
  const ws = makeWebServer();
  ws.registerFallback((req, res) => res.end(BODY));
  const dispose = plugin.apply({ webServer: ws });
  const { port, close } = await listen(ws);
  const res = await rawRequest(port, { path: "/nope", headers: gzipHeaders });
  await close();
  dispose();
  assert.equal(res.headers["content-encoding"], "gzip");
});

test("dispose 完整还原：不再压缩且注册方法复原", async () => {
  const ws = makeWebServer();
  const dispose = plugin.apply({ webServer: ws });
  dispose();
  ws.register({ kind: "exact", path: "/raw", handler: (req, res) => res.end(BODY) });
  const { port, close } = await listen(ws);
  const res = await rawRequest(port, { path: "/raw", headers: gzipHeaders });
  await close();
  assert.equal(res.headers["content-encoding"], undefined);
  assert.deepEqual(res.body, Buffer.from(BODY));
});

// ── DSH 0.2.x：resource 路由 / { resource } fallback ─────────────────

test("resource 路由：HTTP 交换时流式压缩", async () => {
  const { res } = await serveResource(async () => htmlResponse());
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-encoding"], "gzip");
  assert.equal(res.headers["content-length"], undefined);
  assert.equal(res.headers.vary, "accept-encoding");
  assert.deepEqual(gunzipSync(res.body), Buffer.from(BODY));
});

test("resource 路由：readResource（带 peer）保持原始字节", async () => {
  const ws = makeWebServer();
  ws.exact.set("/r", { kind: "exact", path: "/r", resource: async () => htmlResponse() });
  const dispose = plugin.apply({ webServer: ws });
  const peer = { kind: "peer" };
  const response = await ws.exact.get("/r").resource(new Request("http://x/r"), peer);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(await response.text(), BODY);
  dispose();
});

test("resource 路由：HEAD 不压缩", async () => {
  const { res } = await serveResource(async () => new Response(null, { status: 200, headers: { "content-type": "text/html" } }), {
    method: "HEAD",
  });
  assert.equal(res.headers["content-encoding"], undefined);
});

test("resource 路由：已知长度的小响应不压缩", async () => {
  const { res } = await serveResource(
    async () => new Response("hi", { headers: { "content-type": "text/plain", "content-length": "2" } }),
  );
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.body.toString(), "hi");
});

test("resource 路由：未知长度的小响应仍压缩（流式无法预判，语义同内置中间件）", async () => {
  const { res } = await serveResource(async () => new Response("hi", { headers: { "content-type": "text/plain" } }));
  assert.equal(res.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(res.body).toString(), "hi");
});

test("resource 路由：非 gzip 客户端逐字节一致", async () => {
  const { res } = await serveResource(async () => htmlResponse(), { headers: {} });
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.body.toString(), BODY);
});

test("{ resource } fallback：SPA 席位压缩且形态保持", async () => {
  const ws = makeWebServer();
  ws.registerFallback({ resource: async () => htmlResponse() });
  const dispose = plugin.apply({ webServer: ws });
  assert.equal(typeof ws.fallback, "object");
  assert.equal(typeof ws.fallback.resource, "function");
  const { port, close } = await listen(ws);
  const res = await rawRequest(port, { path: "/anything", headers: gzipHeaders });
  await close();
  dispose();
  assert.equal(res.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(res.body), Buffer.from(BODY));
});

test("apply 之后 register 的 resource 路由同样被压缩", async () => {
  const ws = makeWebServer();
  const dispose = plugin.apply({ webServer: ws });
  ws.register({ kind: "exact", path: "/late-r", resource: async () => htmlResponse() });
  const { port, close } = await listen(ws);
  const res = await rawRequest(port, { path: "/late-r", headers: gzipHeaders });
  await close();
  dispose();
  assert.equal(res.headers["content-encoding"], "gzip");
});

test("apply 之后 registerFallback({ resource }) 保持对象形态", async () => {
  const ws = makeWebServer();
  const dispose = plugin.apply({ webServer: ws });
  ws.registerFallback({ resource: async () => htmlResponse() });
  assert.equal(typeof ws.fallback, "object");
  const { port, close } = await listen(ws);
  const res = await rawRequest(port, { path: "/x", headers: gzipHeaders });
  await close();
  dispose();
  assert.equal(res.headers["content-encoding"], "gzip");
});

test("dispose 还原 resource 路由与 { resource } fallback", async () => {
  const ws = makeWebServer();
  const originalResource = async () => htmlResponse();
  const originalFallback = { resource: async () => htmlResponse() };
  ws.exact.set("/r", { kind: "exact", path: "/r", resource: originalResource });
  ws.registerFallback(originalFallback);
  const dispose = plugin.apply({ webServer: ws });
  assert.notEqual(ws.exact.get("/r").resource, originalResource);
  assert.notEqual(ws.fallback.resource, originalFallback.resource);
  dispose();
  assert.equal(ws.exact.get("/r").resource, originalResource);
  assert.equal(ws.fallback.resource, originalFallback.resource);
  assert.equal(ws.fallback, originalFallback);
});

test("宿主已启用内置 gzip 时插件让位（不包装任何东西）", async () => {
  const ws = makeWebServer({ config: { compression: "gzip" } });
  const handler = (req, res) => res.end(BODY);
  ws.exact.set("/", { kind: "exact", path: "/", handler });
  const register = ws.register;
  const dispose = plugin.apply({ webServer: ws });
  assert.equal(ws.exact.get("/").handler, handler);
  assert.equal(ws.register, register);
  dispose();
});
