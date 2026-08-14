# Changelog

本仓库版本采用语义化版本（SemVer）。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.0.0] - 2026-08-15

### Added

- 首个稳定版本：透明 gzip 压缩中间件（宿主侧，`webServer` seam）。
- 包装已注册的 exact / prefix 路由与 fallback，并接管 `register` / `registerFallback`，后续注册的路由自动生效。
- 透传白名单：HEAD / Range、SSE、已编码响应、zip / octet-stream / 图片 / 音视频 / 字体 / wasm、小于 512 字节、204 / 304。
- 正确 HTTP 语义：移除 `content-length`、添加 `content-encoding: gzip`、合并 `vary: accept-encoding`；非 gzip 客户端响应逐字节不变。
- 完整生命周期：disposer 还原全部包装，禁用/卸载无残留。
- 测试套件：`test/gzip.test.mjs`（node:test，19 项断言）+ `test/smoke.sh`。
- 实测基准：`docs/benchmark.md`（session.history 单页 12.6 MB → 1.06 MB，8.4%）。
