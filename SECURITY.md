# Security Policy

## 范围

本插件是纯宿主侧 HTTP 响应中间件：

- **不访问网络**：只处理本进程内 `webServer` 服务的入站 HTTP 响应；
- **不读写文件**：不碰会话存储、不碰磁盘；
- **不接触凭据**：不读取、转发或记录任何 token / cookie / 请求头；
- **不解压任何入站数据**：只做出站压缩（`createGzip`），不存在 zip 炸弹 / 解压攻击面。

## 已知边界

1. **缓冲上限 = 单响应大小**：为决定是否压缩，插件会在内存中缓冲一个响应体。极端大的响应（数百 MB）会占用等量内存——这与「是否安装本插件」无关的语义风险相同，但单用户部署建议留意超大导出流（本插件对 octet-stream 等二进制类型直接透传，不缓冲）。
2. **BREACH 类侧信道**：gzip 压缩理论上存在基于压缩率的侧信道（如 BREACH）。本插件的响应体是已认证用户自己的会话数据，不存在跨源反射内容，风险不适用；如对高敏感部署仍有顾虑，可删除 patch 中本插件的 insert 条目并重启。
3. **依赖 DSH 内部结构**：本插件通过 `webServer` 的 `exact` / `prefixes` / `fallback` 属性与 `register` / `registerFallback` 方法工作。DSH mainline 升级若改动该服务结构，插件可能失效（会以「响应未被压缩」的方式暴露，不会破坏响应本身）；请运行 `test/smoke.sh` 验证。

## 报告问题

请通过 [GitHub Issues](https://github.com/kinyokun/dsh-web-gzip/issues) 报告，勿在公开 issue 中粘贴敏感日志。
