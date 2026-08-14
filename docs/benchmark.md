# Benchmark — 实测基准

> 环境：macOS，Node.js 25，`@deepseek-ai/dsh 0.1.0-rc.6`，真实部署（launchd 托管，公网域名 dsh.kinyokun.cc:5555 → 127.0.0.1:3080）。
> 日期：2026-08-14。

## 方法

对真实服务器依次发起两次 `POST /api/session.history` 请求（同一会话、同一窗口 `maxMessages=50`）：

1. 未装插件：直接读取原始响应字节；
2. 安装插件后：带 `accept-encoding: gzip` 重新读取。

体积用响应体字节数统计，时间用请求往返耗时。

## 结果

| 指标 | 未压缩 | gzip（本插件） |
| --- | --- | --- |
| 响应体积 | 12,586,714 B（12.6 MB） | 1,063,250 B（1.06 MB） |
| 体积占比 | 100% | 8.4% |
| 请求耗时 | 0.151 s | 0.120 s（含 ~60 ms 压缩） |
| `content-length` | 12,586,714 | 移除（分块传输） |
| `content-encoding` | 无 | `gzip` |
| `vary` | 无 | `accept-encoding` |

## 说明

- 该页体积之所以大，是因为会话日志包含大量 `assistant/chunk` 流式增量事件（DSH 日志为 append-only，`/compact` 只压缩模型上下文、不删除日志事件）。这类高度重复的 JSON 正是 gzip 的最佳输入，压缩率约 12:1。
- 单用户部署下压缩 CPU 开销为每响应数十毫秒，远小于公网传输节省的时间。
- 客户端库（如 undici `fetch`）会自动解压 gzip 但保留 `content-encoding` 响应头——做字节级验证时应使用 `node:http` 原始请求（`agent: false`），否则会得到"已解压但仍带 gzip 头"的假象。

## 复现

```bash
# 未压缩基线
curl -sS -o raw.json -w '%{size_download}\n' \
  -H 'content-type: application/json' \
  --data '{"type":"client-request","rpcId":"bench","method":"session.history","payload":{"sessionId":"<id>","maxMessages":50}}' \
  http://127.0.0.1:3080/api/session.history

# 压缩后
curl -sS -o raw.json.gz -w '%{size_download}\n' \
  -H 'content-type: application/json' -H 'accept-encoding: gzip' \
  --data '{"type":"client-request","rpcId":"bench","method":"session.history","payload":{"sessionId":"<id>","maxMessages":50}}' \
  http://127.0.0.1:3080/api/session.history

ls -l raw.json raw.json.gz
```
