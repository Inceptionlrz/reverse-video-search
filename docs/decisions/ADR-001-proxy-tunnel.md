# ADR-001: 使用自研 HTTP CONNECT 隧道作为唯一出站通道

## Status

Accepted（2026-10-24）

## Background

本机的三家搜索引擎访问必须经由本地 HTTP 代理（默认 `http://127.0.0.1:7897`）。在锁定出站方案前，实测了三条现成路径，全部不可用：

| 候选 | 做法 | 实测结果 | 证据 |
|---|---|---|---|
| `undici` | `require('undici')` / `import` | 模块不可解析，本机无该依赖，且项目要求零 npm 依赖 | E-01 |
| 内置 `fetch` + `NODE_USE_ENV_PROXY=1` | Node 22 官方代理开关 | 请求未按代理转发，直连失败 | E-02 |
| 内置 `fetch` + `undici` ProxyAgent | — | 因 E-01 直接排除 | — |

结论：必须在 Node 原生能力之上自建出站通道。同时，还有一条环境限制——

> 本 agent 沙箱中，由 Node spawn 出的子进程发起的出站 HTTPS 会被中间设备替换为 696 字节桩响应（响应头 `server: Microsoft-IIS/10.0`）。见证据 E-04。
> 唯一能取到真实响应的通道是 PowerShell 的 `Invoke-WebRequest`。

这意味着：**隧道本身的连通性在 Node 侧尚未完成端到端验证**（E-05 为待执行项）。这是一个必须显式记录的风险，不能因为"它一定是这样工作的"就跳过验证。

## Decision

采用 **自研 `TunnelAgent`（继承 `node:https` 的 `Agent`，重写 `createConnection`）** 作为所有出站的唯一通道，放在 `server/lib/http/proxy-agent.mjs`。

实现要点：

1. `TunnelAgent extends https.Agent`，只重写 `createConnection(options, callback)`。
2. 在 `createConnection` 内用 `node:http` 向代理发起 `CONNECT host:443 HTTP/1.1`，监听 `res.socket` 的 `connect` 事件得到裸 TCP 套接字。
3. 用 `node:tls` 的 `tls.connect({ socket, servername })` 在该套接字上完成 TLS 升级，把返回的 TLS 套接字交给调用方。
4. 上层照常使用 `https.request(options, cb)` 并 `agent = tunnelAgent`，因此 **multipart 直传仍然可以标准流式写入 body**，不需要手写 HTTP 报文。
5. `RVS_PROXY` 为空时，`createConnection` 退化为原生 `tls.connect`，调用方代码零改动。
6. 三段超时分离设置：CONNECT 建立 8s、TLS 握手 8s、首字节 15s、整体 45s，分别归类为 `TIMEOUT` 或 `NETWORK_ERROR`。

被否决的备选：

| 备选 | 否决理由 |
|---|---|
| 用 `child_process` 调 PowerShell 的 `Invoke-WebRequest` 取真实响应 | 进程创建开销大、无法并发、输出编码不可控、把 UI 层的 PowerShell 依赖带进运行时；且这只是绕过沙箱限制，不是产品能力 |
| 用 `curl` 子进程 | 同样失去流式写入与超时精细控制，且引入对外部可执行文件的隐式依赖 |
| 直接 `http.request` 明文访问目标站点 | 三家引擎全部强制 HTTPS，不可行 |

## Consequences

正面：

- 零 npm 依赖，与 ADR-002 一致。
- 上层 HTTP 语义保持标准，`lib/http/request.mjs` 中的超时、重试、错误分类逻辑与隧道实现解耦。
- 代理可配置为直连，无代理机器仍可运行。

负面：

- 需要自行处理 CONNECT 失败、代理返回非 200、TLS 校验失败三类边界情况，代码量约 120 行。
- 连接池保活、`socket.setNoDelay` 等细节需自行照顾，长连接行为不如成熟库稳健。
- **隧道连通性尚未在 Node 侧端到端验证**（E-05）。

## Follow-up（阻塞级）

**ADR-001 只有在 E-05 补齐后才算完全成立。** 必须执行的验证：

```bash
# 在 Node 侧跑一次 CONNECT 隧道，确认能拿到 200 而非 696 字节桩响应
"$RVS_NODE" tools/probe-tunnel.mjs --target https://lens.google.com/uploadbyurl?url=...
```

判定标准：

- 若返回真实响应（非 696 字节、无 `Microsoft-IIS/10.0` 头）：把 E-05 标记为 `已验证`，回填 `docs/ARCHITECTURE.md` §2.1。
- 若仍返回桩响应：说明限制来自沙箱网络策略而非应用层实现，需在 README 明确"本仓库代码中无法自验证在线检索，需在用户本机运行"，并把所有在线路径的 UI 默认文案改为引导式（首次使用先做一次连通性自检）。

无论哪种结果，**都不改变本 ADR 的选型**——它是当前环境下唯一可行的零依赖方案。

## Related ADRs

- ADR-002（零依赖选型）：本决策是该决策在 HTTP 层的直接结果
- ADR-004（引擎适配器分级降级）：隧道失败时如何降级到 `manual`
