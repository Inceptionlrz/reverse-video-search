# ADR-002: 全栈零 npm 依赖选型

## Status

Accepted（2026-10-24）

## Background

MVP 的部署形态是**用户在本机拉起一个本地服务并打开浏览器**，没有 CI、没有容器编排、没有运维。在这个前提下，依赖的代价被放大：

1. 本机实测 `require('undici')` 不可解析（E-01），说明这台机器上并不存在一个随手可用的 npm 生态。
2. 引入 `better-sqlite3` 之类的原生模块需要本机编译工具链，在用户机器上不可控。
3. 引入 Express 意味着引入约 50 个传递依赖，任何一个出问题都要用户排查 `node_modules`。
4. 前端引入框架就意味着引入构建步骤，用户改一行 JS 要重新打包，违背"本地工具、可直接看源码"的定位。

同时 MVP 的功能面很小：18 个 API 端点、3 个外部引擎适配器、1 个 SQLite 库、1 个静态站点。这个规模下，框架带来的收益低于它引入的不确定性。

## Decision

**运行时零 npm 依赖。** 允许且仅允许 `node:` 前缀的内置模块。

| 能力 | 采用方案 | 替代掉的方案 |
|---|---|---|
| HTTP 入站 | `node:http` 手写前缀树路由 | Express / Fastify / Koa |
| HTTP 出站 | `node:http` + `node:tls` 自研 CONNECT 隧道 | undici / axios / got |
| 数据库 | `node:sqlite`（`--experimental-sqlite`） | better-sqlite3 / Prisma / Drizzle |
| 子进程调用 | `node:child_process` 的 `spawnFile` | fluent-ffmpeg |
| 配置与日志 | 自研约 100 行 | dotenv / pino / winston |
| 前端 | 原生 HTML + 原生 ES Module | React / Vue / Vite |
| 图标 | 内联 SVG sprite | iconify / 图标字体 |

`package.json` 保留，但**只用于登记元信息与 `scripts`**，不含 `dependencies`。若未来确需 devDependency（例如测试），必须新增 ADR 说明。

### 由此产生的三条实现约束

1. **单文件 ≤ 300 行，单一职责。** 没有框架帮忙"藏"复杂度，文件一旦膨胀就没人看得懂。当某文件逼近 300 行时，按职责拆分为同目录多个模块，而不是用注释分区。
2. **`server/bin/rvs.mjs` 只做装配**（加载配置 → 迁移 → 注册路由 → listen），不允许出现任何业务逻辑。
3. **依赖只能向下**：`routes → services → providers|repo|media|queue → lib`，反向 import 视为缺陷。

## Consequences

正面：

- 用户 clone 后无需 `npm install`，`node --experimental-sqlite server/bin/rvs.mjs` 即可运行。
- 没有供应链风险，没有传递依赖的版本漂移。
- 排障路径短：出问题只可能在本仓库代码或 Node 本身。
- 前端改一行立即生效，不需要构建。

负面：

- 路由、 multipart 构造、 HTML 片段提取都要自己写，合计约 400 - 500 行基础设施代码。
- SQLite 操作没有 ORM，需要手写 SQL 与参数绑定；类型安全靠 code review 而非编译器。
- `node:sqlite` 处于实验门后，Node 升级可能变更 API。**缓解措施**：仓储层只暴露异步方法签名，不向上泄漏 SQL 字符串或 `Database` 实例。
- HTML 提取是自研的受限解析器（基于边界标记的片段提取，不是完整 DOM 树），遇到引擎改版需要人工调整 `parse_strategy`。

## 为什么不用更高级但更重的选择

| 选项 | 评分理由 |
|---|---|
| Express + better-sqlite3 + Prisma | 生态成熟度满分，但在本机不可用时（E-01 已证明）任何成熟度都不构成可行性 |
| Deno / Bun 运行时 | 内置能力更强，但本机已锁定 Node v22.22.2 且 `node:sqlite` 已验证可用（E-03），换运行时等于放弃已有验证 |
| 前端用 React | 产品 UI 是 6 个视图页 + 1 个结果表格，交互密度低到不需要虚拟 DOM |

## Related ADRs

- ADR-001：本决策在 HTTP 层的落地结果
- ADR-003：本决策在媒体处理层的落地结果
