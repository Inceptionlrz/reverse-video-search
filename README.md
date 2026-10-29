# reverse-video-search

本地运行的**反向视频溯源**工具：抽帧 → 多引擎以图搜图 → 结果去重排序 → 导出。
全程数据留在本机，外发需逐任务显式授权。

> 本项目是**独立实现**，不抓取、不镜像、不缓存 reverse-video-search.com 的任何付费内容或私有资源。

---

## 它能做什么

| 环节 | 说明 |
|---|---|
| 抽帧 | 固定间隔 / 场景切换 / 两者合并，可设上限与阈值；场景检测不到切换点时回退固定间隔 |
| 去重 | 感知哈希（dHash）在本机计算，相同帧自动分组，不参与重复检索 |
| 检索 | Bing / Yandex / Google Lens 三家，逐引擎并发排队，带熔断与最小间隔 |
| 结果 | 双轨分数（引擎名次 + 本地哈希实算），标注分数来源，不做伪精确 |
| 降级 | 四级链路（直传 → 深链 → 图床桥接 → 手动），**每一级跳过都写进降级日志**，可回溯 |
| 导出 | CSV（防公式注入）/ JSON / 帧图包 |

## 引擎能力（如实标注，不夸大）

| 引擎 | 深链 | 直传 | 图床桥接 | 当前实际 |
|---|---|---|---|---|
| Bing 图片 | 已验证 | 未验证 | 已验证 | **可自动**（勾选桥接并选站点后） |
| Yandex 图片 | 未验证 | 未验证 | 未验证 | 会尝试，结果不保证 |
| Google Lens | 实测不可用 | 端点接受上传 | 不可用 | **只能手动** |

**为什么 Google Lens 不能自动**：它的结果页是纯 JS 应用外壳。
实测 `POST /v3/upload`（字段名 `encoded_image`）返回 **303 并跳转到真实结果页地址**——上传是被接受的；
但跟进该跳转拿到的是 `<noscript>` 跳 `enablejs` 的空壳，`AF_initDataCallback` / `/url?q=` / `data-ved` 全部 0 命中，
外壳内没有任何数据端点。结果全靠客户端 JS 渲染，HTTP 层拿不到。带与不带 cookie 复测结论一致
（证据：`scripts/probe/18-lens-cookie.mjs` 与 `out-H-*.html`）。
不逆向其内部 RPC（极脆弱），也不引入完整浏览器（与零依赖设计冲突）。

Lens 这一路的手动成本已尽量压低：任务详情页 → **手动跑腿工作台**，按帧聚合，
点「复制帧图片」把帧写进剪贴板，到 Lens 上传页按 `Ctrl+V`；或直接把缩略图拖到上传区。

## 环境要求

- **Node.js ≥ 22.5.0**（用到内置 `node:sqlite`，需 `--experimental-sqlite`）
- **ffmpeg / ffprobe**（抽帧与预检的硬依赖，必须可用）
- 零 npm 运行时依赖：`dependencies` 为空，不需要 `npm install`

ffmpeg 缺失时服务不会崩：`/api/health` 会报 `ffmpeg.available: false`，
状态栏显示「ffmpeg 不可用」，上传页给出可操作的危险提示横幅。但要抽帧就必须装上。

## 快速开始

```bash
# 1. 确认 ffmpeg 可用
ffmpeg -version && ffprobe -version

# 2. 启动（默认 http://127.0.0.1:4173）
npm start

# Windows 也可用
start.bat   # 后台启动
stop.bat    # 停止
```

打开 http://127.0.0.1:4173 ，上传视频 → 抽帧 → 发起检索。

### 常用环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `RVS_PORT` | `4173` | 监听端口 |
| `RVS_HOST` | `127.0.0.1` | **只允许回环地址**，非回环直接拒绝启动 |
| `RVS_DATA_DIR` | `<项目>/data` | 数据库、帧、导出目录 |
| `RVS_FFMPEG` / `RVS_FFPROBE` | `ffmpeg` / `ffprobe` | 二进制路径或命令名 |
| `RVS_PROXY` | `http://127.0.0.1:7897` | 出站代理；不需要外网时设为空串 |
| `RVS_OFFLINE` | `0` | `1` = 完全离线，不发任何外网请求 |

## 测试

```bash
npm test        # 单元 + 契约 + 端到端（离线运行，不发起真实外发）
npm run smoke   # 端到端冒烟，校验 HTTP 行为
```

测试全部离线运行（`RVS_OFFLINE=1`）。**需要 ffmpeg 的用例在二进制缺失时会明确跳过并说明原因**，
不会伪装成通过——装好 ffmpeg 后重跑即可覆盖。

## 目录结构

```
server/          分层：routes → services → lib（db/repo、media、queue）
  providers/     三个搜索引擎适配器 + 降级可用性标注
  services/      task / frame / analysis / settings / export / telemetry
public/          零构建前端：原生 ESM + 内联 SVG sprite + Token 化 CSS
tests/           19 个测试文件，含契约测试与变异验证
scripts/probe/   引擎端点实测探针与产物（结论的证据来源）
docs/            PRD / 架构 / UIUX / API / SPEC / ADR / 未决项
```

设计约束：单文件 ≤ 300 行、入口只做装配、依赖只向下、禁止硬编码 hex、禁止渐变与弹跳缓动。

## 已知边界

- 只绑定回环地址，不对外暴露；没有账号体系，单机自用。
- 引擎可达性依赖对方网页结构，任何一家改版都可能让自动链路失效——失效时降级为手动，并在降级日志里写明原因，不会静默失败。
- 浏览器级渲染验证**未自动化**（本开发环境无法运行无头浏览器）。响应式断点是 1279 / 1023 / 767px，
  移动端含 44px 触控目标、`dvh` 弹窗高度、底栏导航；改动视图渲染后建议人工过一遍。

## 许可

仓库内未附加开源许可证文件；如需在外部使用或分发，请先与作者确认。
