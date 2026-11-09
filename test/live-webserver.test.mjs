/**
 * 真实 WebServer 集成测试（可选）。
 *
 * 用已安装的 @deepseek-ai/dsh-host-webserver + cordis 起一个真实的 webServer，
 * 并按 Desktop 的 NextWebServer 方式包一层 policy，验证插件在真实分派下工作。
 * 找不到 DSH 安装时整组 skip —— 这是升级 DSH 后的第一道回归闸门：
 * v1.0.x 在 0.2.x 上让所有请求 400，就是因为 mock 没跟上 { resource } 形态。
 *
 * 运行：node --test test/live-webserver.test.mjs
 * 指定安装位置：DSH_NODE_MODULES=/path/to/@deepseek-ai/dsh/node_modules
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";

const CANDIDATES = [
  process.env.DSH_NODE_MODULES,
  "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules",
  process.env.HOME ? process.env.HOME + "/.dsh/profiles/desktop/node_modules" : undefined,
].filter(Boolean);

function resolveDsh() {
  for (const root of CANDIDATES) {
    try {
      const require = createRequire(root + "/");
      require.resolve("@deepseek-ai/dsh-host-webserver");
      return root;
    } catch {}
  }
  return undefined;
}

const root = resolveDsh();
const skip = root === undefined ? "未找到 @deepseek-ai/dsh-host-webserver，跳过真实 WebServer 集成" : false;

test("真实 WebServer 0.2.x：handler / resource / {resource} fallback 都压缩", { skip }, async () => {
  const require = createRequire(root + "/");
  const { Context } = await import(require.resolve("@deepseek-ai/cordis"));
  const { default: WebServer } = await import(require.resolve("@deepseek-ai/dsh-host-webserver"));
  const plugin = await import("../host.js");

  // 复刻 Desktop 的 NextWebServer 包装（lib/webserver.js + upstream-family 的 wrapRegistration/wrapFallback）
  const policy = {
    handler: (inner) => async (req, res) => inner(req, res),
    resource: (inner) => async (req, peer) => inner(req, peer),
  };
  const wrapRegistration = (route, wrap) =>
    "resource" in route
      ? { ...route, resource: wrap.resource(route.resource) }
      : { ...route, handler: wrap.handler(route.handler) };
  const wrapFallback = (fallback, wrap) =>
    typeof fallback === "function" ? wrap.handler(fallback) : { resource: wrap.resource(fallback.resource) };

  class NextWebServer extends WebServer {
    register(route) {
      return super.register(wrapRegistration(route, policy));
    }
    registerFallback(fallback) {
      return super.registerFallback(wrapFallback(fallback, policy));
    }
  }

  const ctx = new Context();
  await ctx.plugin(NextWebServer, { host: "127.0.0.1", port: 0 });
  const ws = ctx.webServer;
  const origin = ws.getOrigin();
  const { port } = new URL(origin);

  const body = JSON.stringify({ items: Array.from({ length: 2000 }, (_, i) => ({ i, t: "x".repeat(80) })) });
  const page = "<!doctype html><html><body>" + body + "</body></html>";

  ws.registerFallback({
    resource: async () =>
      new Response(page, { headers: { "content-type": "text/html", "content-length": String(Buffer.byteLength(page)) } }),
  });
  ws.register({
    kind: "exact",
    path: "/api/handler",
    handler: (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(body);
    },
  });
  ws.register({
    kind: "exact",
    path: "/api/resource",
    resource: async () =>
      new Response(body, { headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }),
  });

  const dispose = plugin.apply(ctx);
  ws.register({
    kind: "exact",
    path: "/late-resource",
    resource: async () => new Response(page, { headers: { "content-type": "text/html" } }),
  });

  const raw = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
        const parts = [];
        res.on("data", (d) => parts.push(d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      });
      req.on("error", reject);
      req.end();
    });

  try {
    for (const [path, expected] of [
      ["/", page],
      ["/api/handler", body],
      ["/api/resource", body],
      ["/late-resource", page],
    ]) {
      const gz = await raw(path, { "accept-encoding": "gzip" });
      assert.equal(gz.status, 200, path);
      assert.equal(gz.headers["content-encoding"], "gzip", path);
      assert.equal(gz.headers.vary, "accept-encoding", path);
      assert.equal(gunzipSync(gz.body).toString(), expected, path);

      const identity = await raw(path);
      assert.equal(identity.headers["content-encoding"], undefined, path);
      assert.equal(identity.body.toString(), expected, path);
    }

    // readResource 传 peer：进程内读取必须保持原始字节
    const read = await ws.readResource(new Request(origin + "/"), { kind: "peer" });
    assert.equal(read.headers.get("content-encoding"), null);
    assert.equal(await read.text(), page);
  } finally {
    dispose();
    // 真实 listener 会一直持有事件循环；测试结束前显式关掉，避免 node --test 挂起。
    ws.server?.closeAllConnections?.();
    ws.server?.close?.();
    await ctx.dispose?.();
  }
});
