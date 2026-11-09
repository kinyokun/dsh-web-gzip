# dsh-web-gzip

<p align="center">
  <img alt="license" src="https://img.shields.io/github/license/kinyokun/dsh-web-gzip">
  <img alt="version" src="https://img.shields.io/github/package-json/v/kinyokun/dsh-web-gzip">
  <img alt="DSH" src="https://img.shields.io/badge/DSH-0.2.2--rc.1%20%E5%AE%9E%E6%B5%8B-blue">
  <img alt="zero deps" src="https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E6%97%B6%E4%BE%9D%E8%B5%96-0-green">
</p>

DSH（DeepSeek Harness）宿主插件：给 `dsh web` 的 HTTP 响应加**透明 gzip 压缩**，专治**公网远程访问时「会话记录」加载慢**。

> A zero-dependency host plugin that transparently gzip-compresses DeepSeek Harness web responses — dramatically accelerating remote session-history loading.

## Overview

**解决什么问题**：DSH 的 Web 栈没有任何 HTTP 压缩中间件，而 `session.history` 一页可能携带数 MB 的裸 JSON（内含大量 `assistant/chunk` 流式增量事件）。局域网直连尚可忍受，经公网域名 / 反代 / 隧道访问时，每一页历史都是数 MB 的原样传输——这就是"会话记录加载慢"的主因。文本类内容 gzip 压缩率约 10:1。

**实测效果**（本机真实部署，`session.history` 单页 50 条消息）：

| 指标 | 未压缩 | 本插件 |
| --- | --- | --- |
| 响应体积 | 12,586,714 B (12.6 MB) | 1,063,250 B (1.06 MB) |
| 占比 | 100% | **8.4%** |
| 响应头 | — | `content-encoding: gzip` + `vary: accept-encoding` |

**适合谁**：通过公网域名 / Cloudflare / 内网穿透 / Tailscale 等远程访问 DSH Web GUI 的用户；`/export` 之外希望"零改动、零配置"提速所有页面（API JSON + 静态资源）的用户。

### DSH 0.2.x 兼容说明（v2.0.0）

DSH 0.2.0 起 `webServer` 的路由模型变成两种形态，且 SPA 的 fallback 席位改成 `{ resource }`：

```js
{ kind, path, handler(req, res) }          // node 语义，自己持有响应
{ kind, path, resource(request, peer) }    // Fetch 语义，返回 Response
```

v1.0.x 只认 `handler` 与函数式 fallback，会把 `{ resource }` 当函数调用 → **每个请求都 400**（2026-11 的真实故障）。v2 的做法：

- handler 路由：缓冲响应体，`end()` 时决定压缩 / 透传（老路径，修了状态码与 `flushHeaders`）；
- resource 路由：对 `Response` 用 `CompressionStream("gzip")` **流式**压缩，不整体缓冲；只在真实 HTTP 交换（`peer === undefined`）时压缩，`readResource` 的进程内读取返回原始字节；
- 注册方法与 fallback 保持原形态，disposer 完整还原。

DSH 0.2.0 还给 `webServer` 加了内置压缩（`compression: gzip`）。**如果宿主已开启，本插件自动让位**（不重复编码、不再缓冲）——此时更推荐直接用内置配置，插件仅在老版本或未开启内置压缩的部署里承担压缩。

## Features

- **全路由覆盖**：包装 `webServer` 已注册的 exact / prefix 路由与 fallback（handler 与 resource 两种形态都支持），并接管 `register` / `registerFallback`——本插件加载**之后**注册的路由同样自动压缩；
- **resource 流式压缩**：静态资源 / SPA 页面等 resource 路由边读边压，不占整份响应大小的内存；handler 路由仍按需缓冲（无法预知 content-type）；
- **智能透传白名单**（不缓冲、逐字节原样）：
  - `HEAD` / `Range` 请求（字节精确语义）；
  - SSE（`text/event-stream`）——保持逐块即时到达；
  - 已自带 `content-encoding` 的响应；
  - `zip` / `gzip` / `octet-stream` / `wasm` / 图片 / 音视频 / 字体（压缩收益低或语义不允许）；
  - 小于 512 字节的小响应（压缩反而亏）；
  - `204` / `304` 空响应；
- **正确 HTTP 语义**：压缩时移除 `content-length`、添加 `content-encoding: gzip`、合并 `vary: accept-encoding`（缓存安全）；
- **对非 gzip 客户端零影响**：不带 `Accept-Encoding: gzip` 的客户端（如本机 dsh-cli）收到的响应与未安装时**逐字节一致**；
- **与内置 gzip 共存**：宿主 `webServer.compression: gzip` 已开启时自动让位，绝不双重编码；
- **可逆生命周期**：禁用 / 卸载时 disposer 完整还原所有 handler / resource 与注册方法，无残留；
- **零运行时依赖**：仅 `node:zlib`（Node 内置）；不碰业务逻辑、会话数据与磁盘。

## Install / Uninstall

### 方式一：profile 目录直接挂载（推荐，最简单）

1. 把仓库放进 profile 目录（目录名即插件名）：

   ```bash
   PROFILE_DIR=~/.dsh/profiles/web        # profile 名按实际部署调整
   mkdir -p "$PROFILE_DIR/dsh-web-gzip"
   cp host.js package.json "$PROFILE_DIR/dsh-web-gzip/"
   ```

2. 在 `$PROFILE_DIR/cordis.patch.yml` 追加插件行：

   ```yaml
   - insert:
       - id: dsh-web-gzip
         name: ./dsh-web-gzip/host.js
   ```

3. 重启 `dsh web`（宿主代码在模块缓存中，需进程重启生效；launchd 等托管方式会自动拉起）。
4. 刷新浏览器页面即可——无需任何配置。

#### DSH NEXT 桌面版（profile `desktop`）

桌面版的 Web 服务由 app 内的 Host 进程提供（`~/.dsh/profiles/desktop`），装法完全相同：

```bash
PROFILE_DIR=~/.dsh/profiles/desktop
mkdir -p "$PROFILE_DIR/dsh-web-gzip"
cp host.js package.json "$PROFILE_DIR/dsh-web-gzip/"
# 然后在 $PROFILE_DIR/cordis.patch.yml 追加同一个 insert 条目
```

改完需要**重启 DSH NEXT**（退出再打开，或在应用内重启）——Host 进程重启后生效。

### 方式二：作为包名挂载

   ```bash
   PROFILE_DIR=~/.dsh/profiles/web
   mkdir -p "$PROFILE_DIR/node_modules/dsh-web-gzip"
   cp host.js package.json "$PROFILE_DIR/node_modules/dsh-web-gzip/"
   ```

   ```yaml
   - insert:
       - id: dsh-web-gzip
         name: dsh-web-gzip
   ```

### 升级

覆盖 `host.js` / `package.json` 后重启 `dsh web` 并刷新页面。

### 禁用

在 patch 中追加 `- id: dsh-web-gzip` + `disabled: true`（保留文件，随时可重新启用）。

### 彻底移除

删除 patch 中的 insert 条目与插件目录，重启 `dsh web`。

## Configuration

无持久化设置。全部行为由 `host.js` 顶部常量控制（修改后重启生效）：

| 常量 | 默认 | 说明 |
| --- | --- | --- |
| `MIN_BODY_BYTES` | 512 | 响应体低于该字节数不压缩 |
| `GZIP_LEVEL` | 6 | gzip 级别（1-9，速度/压缩率平衡点） |
| `SKIP_CONTENT_TYPES` | 见源码 | 透传内容类型前缀白名单 |

## Compatibility

| 项目 | 声明 |
| --- | --- |
| 支持的 DSH 版本 | **`@deepseek-ai/dsh 0.2.2-rc.1`**（2026-11-09 实测：单元测试 31 项 + 真实 `WebServer` 集成 + Desktop `NextWebServer` 子类 + 真实 `dsh web` 静态资源 / index 响应头） |
| 兼容的旧版本 | 0.1.0-rc.6（v1 行为不变；resource 路由不存在时自动只走 handler 分支） |
| 已验证环境 | macOS + Node.js 22/26；`dsh web` profile patch 挂载；DSH NEXT 2.0.22（desktop profile）与全局 `dsh web`（web profile） |
| 最后验证日期 | 2026-11-09 |
| 已知耦合点 | `webServer` 的 `exact` / `prefixes` / `fallback` 与 `register` / `registerFallback`，以及路由的 handler / resource 形态（见 SECURITY.md）。DSH 升级改动该结构时需同步适配；v1 在 0.2.x 上曾因此让所有请求 400 |

DSH mainline 变化很快：升级 DSH 后先跑 `node --test test/gzip.test.mjs`，再在 staging 上用 `curl -H 'Accept-Encoding: gzip' -D -` 验证真实响应头。

## Testing

```bash
node --test test/gzip.test.mjs     # 或直接运行 test/smoke.sh
```

测试套件用 mock `webServer`（DSH 0.2.x 形态）+ 真实 `node:http` 服务器做字节级断言：gzip 往返、压缩率、SSE / zip / 图片 / 小响应 / HEAD / Range / 204 / 304 / 已编码响应透传、`vary` 合并、`content-length` 移除、非 gzip 客户端逐字节一致、handler 抛错 400 兜底、加载后注册路由生效、disposer 完整还原；以及 resource 路由流式压缩、`readResource` 保持原始字节、`{ resource }` fallback、内置 gzip 让位。

## FAQ

- **为什么不支持 brotli / zstd？** 浏览器普遍支持 gzip，且 gzip 是 `node:zlib` 内置、零依赖、跨 Node 版本稳定的选择。若后续需要，可在 `wrapHandler` 中按 `Accept-Encoding` 扩展。
- **会压缩 WebSocket 吗？** 不会。本插件只包装 HTTP handler / resource，upgrade 路由（`registerUpgrade`）不经过包装。
- **对会话文件本身有影响吗？** 没有。只改"响应传输"，不碰 `session.jsonl.zstd` 等任何磁盘数据。
- **和 `/compact` 的区别？** `/compact` 压缩的是发给模型的**上下文**（会话文件只追加不删除）；本插件压缩的是**网络传输**。两者互补。

## License

[MIT](LICENSE) © 2026 kinyokun
