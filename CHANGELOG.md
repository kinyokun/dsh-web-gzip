# Changelog

本仓库版本采用语义化版本（SemVer）。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [2.0.0] - 2026-11-09

### Fixed

- **兼容 DSH 0.2.x 的双路由模型**：`webServer` 现在既有 handler 路由也有 resource 路由，SPA 的 fallback 席位也从裸 handler 变成 `{ resource }`。v1.0.x 只认 `route.handler` / function fallback，把 `{ resource }` 当函数调用，导致 DSH 0.2.2 升级后**每个请求都返回 400**。v2 按形态分别包装，并保持注册形态不变。
- **修复 handler 包装的状态码 bug**：handler 直接写 `res.statusCode`（而非 `writeHead`）时，204 / 304 会被改写成 200；现在以真实状态码为准。
- **修复 `flushHeaders` 语义**：调用 `flushHeaders()` 视为流式响应，立即把已缓冲的头部与字节透传出去（v1 会吞掉 flush，影响长连接/下载）。

### Added

- **resource 路由流式压缩**：对 Fetch `Response` 用 `CompressionStream("gzip")` 边读边压，不再整体缓冲；只对真实 HTTP 交换生效，`readResource` 的进程内读取保持原始字节。
- **与 DSH 内置 gzip 共存**：检测到 `webServer.config.compression === "gzip"`（DSH 0.2.0 起的内置 listener 级中间件）时自动让位，不重复编码、不缓冲，只记一条日志。
- 测试从 19 项扩到 31 项，新增 resource 路由、`{resource}` fallback、`readResource`、内置 gzip 让位、状态码等用例。

### Changed

- `version` 导出与 `package.json` 同步为 2.0.0；`npm test` 直接跑测试。

## [1.0.0] - 2026-08-15

### Added

- 首个稳定版本：透明 gzip 压缩中间件（宿主侧，`webServer` seam）。
- 包装已注册的 exact / prefix 路由与 fallback，并接管 `register` / `registerFallback`，后续注册的路由自动生效。
- 透传白名单：HEAD / Range、SSE、已编码响应、zip / octet-stream / 图片 / 音视频 / 字体 / wasm、小于 512 字节、204 / 304。
- 正确 HTTP 语义：移除 `content-length`、添加 `content-encoding: gzip`、合并 `vary: accept-encoding`；非 gzip 客户端响应逐字节不变。
- 完整生命周期：disposer 还原全部包装，禁用/卸载无残留。
- 测试套件：`test/gzip.test.mjs`（node:test，19 项断言）+ `test/smoke.sh`。
- 实测基准：`docs/benchmark.md`（session.history 单页 12.6 MB → 1.06 MB，8.4%）。
