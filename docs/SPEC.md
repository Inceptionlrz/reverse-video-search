# Spec — Reverse Video Search 本地版 v1.0.0

> 生成日期：2026-10-24
> 基于：PRD v1.0 + ARCHITECTURE v1.0 + UIUX v1.0（含 design-tokens.json / .css）
> 状态：**已确认**（用户已在 Phase 0 锁定三项关键选型，本 Spec 为团队内部契约）
> 适用：MVP，本地单机，零 npm 运行时依赖

---

## 0. 合规红线（优先于一切功能）

1. **不抓取、不镜像、不缓存原站（reverse-video-search.com）的付费内容、私有资源、接口响应、令牌或积分数据。** 所有结果必须由本应用自行向公开引擎发起检索产生。
2. **不绕过**任何第三方引擎的验证码、登录、付费墙、限频或机器人防护。遇到即降级为手工流程。
3. 页面结构与接口**按参考实现的形态独立重写**，不是对其响应的复制或代理。
4. 只允许缓存：本应用自产的帧、本应用检索得到的结果、用户显式开启的远程缩略图本地副本。
5. 本地服务仅绑定 `127.0.0.1`，不监听局域网。

---

## 1. 产品定义

- **一句话**：在本地把视频拆成关键帧，逐帧送进多个公开反向图片搜索引擎，帮你找出这段视频可能的原始出处。
- **目标用户**：需要为视频片段溯源的人——版权维权者、内容溯源记者、二创素材核查者。
- **核心问题**：原站对原始结果收费；而"抽帧 + 以图搜图 + 汇总"这件事本身可以用公开引擎在本地完成。

## 2. MVP 范围（锁定——不在此列表的功能一律不做）

| 优先级 | 能力包 | 验收标准摘要 | RICE |
|---|---|---|---|
| P0 | A. 本地视频预检与可配置抽帧 | 固定间隔/场景切换/混合三种模式；帧数上限；抽帧后本地可增删帧、帧去重分组；完全离线可用 | 7.50 |
| P0 | B. 多引擎搜图与透明降级 | 引擎选择、发送前确认、四级降级、引擎级熔断、按引擎暂停/重试 | 3.00 |
| P0 | C. 批量任务与结果包 | 多视频排队、跨任务去重、按相似度排序、CSV/JSON 导出、暂停与断点恢复 | 3.09 |
| P1 | D. 图片直搜 | 不走视频，直接对一张图跑同一条链路 | 3.00 |
| P1 | E. 历史与存储管理 | 任务重命名、占用空间、按任务清理 | 2.13 |

> P1 的 D 与 E 在本版中**以最小形态实现**：D 复用同一条 analysis 链路（单帧任务）；E 仅提供"删除任务并清理"与"占用空间显示"。

## 3. 明确不做（Out-of-Scope — 锁定）

| 不做项 | 原因 | 何时考虑 |
|---|---|---|
| 抓取/镜像/缓存原站付费内容与私有资源 | 合规红线（§0） | 永不 |
| 绕过验证码/登录/付费墙/限频/地域限制 | 合规与封禁风险 | 永不 |
| 自建全网爬虫与索引 | 成本版权远超本地 MVP | 永不 |
| 人脸/人物身份识别 | 隐私与滥用风险 | 永不 |
| 云端账号、订阅计费、多租户、云同步 | 本地单机工具定位 | 永不 |
| 从 TikTok/YouTube/Instagram URL 自动下载视频 | 平台条款与版权风险 | 永不 |
| 移动端 / 微信内运行 | 抽帧与批量任务约束大 | v2+ |
| 保证找到"唯一原始来源"或保证召回率 | 第三方索引非穷尽 | 永不 |
| 自动发送 DMCA / 平台投诉 | 法律判断与误伤风险 | 永不 |
| 永久缓存第三方源页面全文 | 版权与陈旧数据风险 | 永不 |

## 4. 技术架构（锁定 — 含版本锚定）

| 层 | 技术 | 实际版本 | 锁定原因 |
|---|---|---|---|
| 运行时 | Node.js | **22.22.2** | 内置 `node:sqlite`，本机唯一已确认可用且带 sqlite 的运行时 |
| SQLite 启用 | 启动参数 `--experimental-sqlite` | Node 22.22.2 | `node:sqlite` 在实验门后 |
| HTTP 入站 | `node:http` 手写路由 | 内置 | 端点少，零依赖优先 |
| HTTP 出站 | `node:http` + `node:tls` + 自研 `TunnelAgent` | 内置 | `undici` 不可解析；`NODE_USE_ENV_PROXY` 实测无效 |
| 存储 | `node:sqlite` | 内置 | 单用户本地工具，避免本机编译依赖 |
| 视频元数据 | `ffprobe` CLI | ffmpeg **8.1.1** | 唯一可行途径 |
| 抽帧 / 图像处理 | `ffmpeg` CLI | ffmpeg **8.1.1** | 唯一可行途径；同时承担转 JPEG、缩放、灰度 |
| 感知哈希 | 自研 dHash（Node 纯 JS） | — | ffmpeg 出 9×8 灰度，Node 侧 64 次比较 |
| 前端 | 原生 ES Module，无框架无打包 | — | 离线可用，零构建 |
| 图标 | 内联 SVG sprite `rvs-icon-{name}` | 24 viewBox / stroke 1.5 / currentColor | 零外部请求，禁 emoji |
| 测试 | `node:test` + `node --check` | 内置 | 零依赖 |
| 包管理 | **运行时零 npm 依赖**；`package.json` 仅登记元信息与脚本 | — | 免安装即可运行 |

**禁止**：
- 代码中出现 `fetch(`（一律走 `TunnelAgent` 的 `https.request`）
- 拼接 shell 字符串调用 ffmpeg（一律 `spawnFile` + 参数数组）
- emoji 充当功能图标
- 硬编码颜色（唯一例外 `#fff` / `#000`）
- 紫→粉渐变
- 单文件 > 300 行；单函数 > 60 行

## 5. 数据库表清单（锁定）

```
tasks          任务（一个视频 = 一个任务）
  id TEXT PK            created_at INTEGER
  source_type TEXT      'file' | 'url'
  source_name TEXT      display_name TEXT
  source_path TEXT      source_url TEXT
  status TEXT           phase TEXT
  duration_ms INTEGER   width INTEGER  height INTEGER
  codec TEXT            extract_mode TEXT
  max_frames INTEGER    scene_threshold REAL
  ffmpeg_error TEXT     created_ms INTEGER  updated_ms INTEGER
  frames_done INTEGER   analyses_done INTEGER  analyses_total INTEGER
  confirmed INTEGER

frames         帧
  id TEXT PK            task_id TEXT      seq INTEGER
  file_name TEXT        file_path TEXT    url_path TEXT
  time_ms INTEGER       width INTEGER     height INTEGER
  dhash TEXT            dup_group INTEGER is_duplicate INTEGER
  enabled INTEGER
  UNIQUE(task_id, seq)

analyses       帧 × 引擎的一次执行
  id TEXT PK            task_id TEXT      frame_id TEXT
  provider TEXT         attempt_mode TEXT hit_source TEXT
  status TEXT           error_code TEXT   error_message TEXT
  request_url TEXT      http_status INTEGER
  latency_ms INTEGER    started_ms INTEGER  finished_ms INTEGER
  degradation_log TEXT
  UNIQUE(frame_id, provider)

results        去重后的唯一来源线索
  id TEXT PK            url TEXT          canonical_url TEXT UNIQUE
  domain TEXT           title TEXT        provider TEXT
  rank INTEGER          score_basis TEXT
  local_hash_similarity REAL   sort_score REAL
  thumb_url TEXT        thumb_local_path TEXT  thumb_status TEXT
  discovered_ms INTEGER

result_hits    线索 × 证据（哪帧、哪个引擎命中）
  id TEXT PK            result_id TEXT    analysis_id TEXT
  frame_id TEXT         task_id TEXT      provider TEXT
  rank INTEGER          score_basis TEXT
  local_hash_similarity REAL   sort_score REAL
  UNIQUE(analysis_id, rank)

engine_health  引擎级熔断与限频
  provider TEXT PK      enabled INTEGER
  consecutive_failures INTEGER  circuit_until_ms INTEGER
  last_success_ms INTEGER        last_failure_ms INTEGER
  last_error_code TEXT

settings       单例 KV
  key TEXT PK           value TEXT
```

索引：`idx_frames_task`、`idx_analyses_task`、`idx_analyses_frame`、`idx_analyses_status`、`idx_hits_result`、`idx_hits_task`、`idx_results_sort`。

## 6. API 端点清单（锁定）

统一前缀 `/api`，JSON，错误体 `{ ok:false, error:{ code, message, detail } }`。

| # | Method | Path | 功能 |
|---|---|---|---|
| 1 | GET | `/api/health` | 进程状态、ffmpeg 版本、DB 状态、代理连通性 |
| 2 | POST | `/api/file-upload` | 提交本地文件/图片 URL 建任务（对应原站 file-upload 形态），返回 `task_id` 与预检结果 |
| 3 | GET | `/api/tasks` | 任务队列列表（状态/进度/帧数/命中数/耗时） |
| 4 | GET | `/api/tasks/:id` | 任务详情 |
| 5 | POST | `/api/tasks/:id/confirm` | 用户确认外发（写 `tasks.confirmed=1`） |
| 6 | POST | `/api/tasks/:id/extract` | 触发抽帧（mode / max_frames / scene_threshold） |
| 7 | GET | `/api/tasks/:id/frames` | 帧列表（含 dhash、去重分组、enabled） |
| 8 | PATCH | `/api/tasks/:id/frames` | 批量启用/禁用帧 |
| 9 | POST | `/api/search/run-analyses` | 启动分析（task_id / providers / frames），返回 `analysis_ids` |
| 10 | GET | `/api/search/analyses/:id` | 单个 analysis 状态与降级日志 |
| 11 | GET | `/api/tasks/:id/analyses` | 任务下全部 analysis（矩阵视图） |
| 12 | POST | `/api/tasks/:id/control` | `{action: pause|resume|cancel|retry-failed}` |
| 13 | GET | `/api/results` | 结果集：`task_id` / `q` / `domain` / `provider` / `min_score` / `dedupe` / `sort` / `order` / `limit` / `offset` |
| 14 | GET | `/api/results/:id/hits` | 单条线索的证据链（哪帧哪引擎命中） |
| 15 | GET | `/api/export.csv` | CSV 导出（遵循当前筛选，含 BOM 与 CSV 注入防护） |
| 16 | GET | `/api/export.json` | JSON 导出（含 schema 版本与生成时间） |
| 17 | GET | `/api/engines` | 引擎状态、模式开关、熔断剩余秒数 |
| 18 | PATCH | `/api/engines/:provider` | 启停引擎、切换 upload 模式 |
| 19 | GET/PUT | `/api/settings` | 设置读写（含 imagehost 开关、并发、超时、代理、导出目录） |
| 20 | GET | `/api/engines/:provider/probe` | 引擎连通性自测（最多 6s） |
| 21 | GET | `/api/logs` | 结构化日志（level / source / since / limit） |
| 22 | DELETE | `/api/tasks/:id` | 删除任务并清理自产帧与结果 |
| — | GET | `/frames/<task_id>/<file>` `/thumbs/<file>` | 静态帧与缩略图 |

## 7. 页面清单（锁定）

| # | 路由 | 页面名 | 核心组件 |
|---|---|---|---|
| 1 | `/` | 溯源工作台 | TopBar、DropZone、TaskQueueTable、EngineHealthStrip、StatusBar、ConfirmSheet、DegradedBanner |
| 2 | `/tasks/:id` | 任务详情 | TaskHeader、FrameStrip、SendBar、EngineMatrix、ResultToolbar、ResultList、InspectorPanel |
| 3 | `/results` | 结果总览 | GlobalFilterBar、ResultTable、InspectorPanel、ExportSheet |
| 4 | `/engines` | 引擎诊断 | EngineCard ×3、ProbeButton、RetryPolicyEditor、ManualFallbackCard |
| 5 | `/settings` | 设置 | 五个 Section（抽帧/引擎/网络与存储/外观/危险操作） |
| 6 | `/logs` | 运行日志 | LogViewer、LevelFilter |
| 7 | `/*` | 404 | NotFoundCard |

组件按 `文件名.类型.mjs` 拆分，全局状态放 `store`，跨组件通信放 `bus`。

## 8. 设计 Token（锁定）

- **来源**：`docs/design-tokens.json` + `docs/design-tokens.css`（设计师产出，前端直接引入，不得改写数值）
- **默认主题**：深色（V1 只做深色，浅色 token 已在文件中预留，UI 不暴露切换器）
- **底色**：`#0D1117`　**文本**：`#E6EDF3`　**强调色**：`#2F81F7`
- **字体**：`Inter` / `system-ui` / `PingFang SC` / `Microsoft YaHei` / `Noto Sans SC`；数字与哈希值用 `ui-monospace` / `Cascadia Mono`
- **密度**：7/10（28px 紧凑表行，间距 4 的倍数，圆角 4/6/8）
- **图标**：内联 SVG sprite，36 个图标，尺寸 16/20/24px（`design-tokens.json → icons`）
- **动效**：120ms 出现、180ms 展开、160ms 数值过渡，`ease-out`；**禁止弹跳缓动**
- **对标**：Linear（克制密度）+ Figma（数值精度）

### 8.1 重要展示规范

- **分数双轨**：`排序分`（0–100，由引擎名次映射，`score_basis='engine_rank'`）+ `本地哈希相似度`（0–100，dHash 实算，`score_basis='local_hash'`）。
  - 两列并存，表头下方有说明条。
  - 无分数项显示 `—` + `未提供` 徽标，排序时稳定沉底。
  - **UI 文案统一称"排序分"，不得出现"线索分"**（数据字段名仍为 `sort_score`）。
- **降级提示**：引擎级 `DegradedBanner` 为**信息态**（`info`），不是错误态；文案必须"发生了什么 + 已切到什么 + 你能做什么"三要素。

## 9. 相似度口径（锁定）

| 名称 | 计算方式 | 可解释性 | 排序用途 |
|---|---|---|---|
| `sort_score` 排序分 | `100 - (rank-1) * 5`，下限 20 | 引擎返回名次 | 默认排序键 |
| `local_hash_similarity` 本地哈希相似度 | 帧 dHash 与结果缩略图 dHash 的汉明距离 `sim = (1 - H/64) * 100` | 本地实算，可复现 | 可选排序键、筛选阈值 |
| 无分数 | 显示 `—` | — | 稳定沉底 |

排序键：`sort_score` / `local_hash_similarity` / `hits` / `discovered`。默认 `sort_score desc`。

## 10. 降级处理（锁定）

四级链路，每级失败写入 `analyses.degradation_log`，UI 可展开查看原因链：

```
[0] 前置判定：引擎禁用 / 熔断中 / 代理不可达 → 直接 manual
[1] upload（multipart 直传）  默认【关闭】，实验性（未验证端点）
[2] deeplink（URL 深链）      默认【开启】，已验证形态；需要公网可达图片 URL
[3] bridge（图床桥接）        默认【开启】（用户决策），但仍需【单任务逐一确认】
[4] manual（手工检索指引）    永不是失败态，是"待用户动作"态
```

**开关默认值（用户已决策）**：

| 开关 | 默认值 | 额外闸门 |
|---|---|---|
| `deeplink` | 开 | 无公网 URL 时自动跳过 |
| `bridge`（图床） | **开** | 设置页必须明示"会把视频中的一帧上传到第三方公开图床，任何拿到链接的人都能看到它"；**每个任务仍需单独确认**，不得一次开启无限期生效 |
| `upload`（multipart 直传） | **关** | 端点未验证，用户自行承担风险后手动开启 |
| `imagehost` 具体站点 | 关 | 用户显式选择 catbox / 0x0.st / tmpfiles.org 之一 |

图床上传前必须把帧缩放到长边 ≤ 640 并重编码为 JPEG q=3；返回的 URL 写入 `analyses.request_url`，结果标注"该帧曾由第三方图床中转"。

**错误码字典**：`RATE_LIMITED` / `FORBIDDEN` / `CAPTCHA` / `NETWORK_ERROR` / `TIMEOUT` / `PARSE_ERROR` / `UPLOAD_REJECTED` / `PROXY_UNREACHABLE` / `PROVIDER_DISABLED` / `ZERO_RESULT`（成功零命中，**不算错误**）

**工程兜底（本机实测）**：Windows 下在 Bash 中启动的 Node 服务会随 Bash 调用结束被终止。必须用 `start.bat`（`start "" /B "<node>" ...`）以脱离进程树的方式启动，并提供 `stop.bat` 按端口精确终止。**禁止**使用会杀掉整棵进程树的停止脚本。

## 11. 边界与约束

- 本地服务仅绑定 `127.0.0.1`，默认端口 `4173`（可配置）。
- 断点：1s 隧道建连 / 3s TLS 握手 / 5s 首字节 / 15s 整体。
- 并发：默认 2；Bing 与 Yandex 串行；Google 与它们并行。
- 请求间隔：默认 1200ms，抖动 ±20%。
- 熔断：连续 3 次 `RATE_LIMITED`/`FORBIDDEN` 熔断 10 分钟。
- 单文件 ≤ 300 行，单函数 ≤ 60 行。
- 支持：Windows 10/11 + Chrome/Edge 最近两个稳定版。

## 12. 端到端验证步骤

```bash
# 1. 冒烟（无网络、无浏览器）
node scripts/smoke.mjs

# 2. 启动（Windows，脱离进程树）
start.bat          # 等待输出 "RVS ready on http://127.0.0.1:4173"

# 3. 健康检查
curl -s http://127.0.0.1:4173/api/health

# 4. 建任务 + 抽帧（离线可完成）
curl -s -X POST http://127.0.0.1:4173/api/file-upload -H 'content-type: application/json' \
  -d '{"source_type":"file","source_path":"D:/tmp/s.mp4","display_name":"s.mp4"}'
curl -s -X POST http://127.0.0.1:4173/api/tasks/<task_id>/extract \
  -H 'content-type: application/json' -d '{"mode":"interval","max_frames":5}'
# 断言：返回 frames 数组非空，每帧含 time_ms 与 dhash

# 5. 引擎连通性自测（可失败，失败必须降级而非崩溃）
curl -s http://127.0.0.1:4173/api/engines/bing/probe
# 断言：返回 { ok:true, data:{ reachable: <bool>, error_code: <string|null> } }，HTTP 状态恒为 200

# 6. 导出（离线可完成）
curl -s "http://127.0.0.1:4173/api/export.csv?task_id=<task_id>" -o out.csv
curl -s "http://127.0.0.1:4173/api/export.json?task_id=<task_id>" -o out.json

# 7. 停止
stop.bat
```

## 13. 变更记录

| 日期 | 变更内容 | 原因 | 影响范围 |
|---|---|---|---|
| 2026-10-24 | 初版 Spec 生成 | 基于已确认的 PRD/架构/UIUX | 全局 |
| 2026-10-24 | 需求第 3 条中的"抓取/镜像/缓存原站付费内容与私有资源"剔除，改为独立实现 + 仅缓存自产数据 | 合规红线 | §0、§3 |
| 2026-10-24 | 相似度改为双轨（排序分 + 本地哈希相似度） | 用户选择，且公开引擎不返回真实相似度 | §8.1、§9 |
| 2026-10-24 | 启动方式改为 `start.bat` 脱离进程树 | Windows 下 Bash 子进程随调用结束被杀（实测） | §10、§12 |
| 2026-10-24 | 新增实现侧 EARS #23–#27（PM 升格）与实现侧验收项 8 条（设计师） | 安全项仅在非功能表格出现、无 EARS 编号，验收时最易被静默跳过 | §14 |

## 14. 实现侧验收项（必须逐项签字，不接受"整体通过"）

> PRD EARS 现已 28 条（含 17b）。以下 8 条属**实现侧**，设计侧的文本扫描脚本验不出，必须单独核验。

| # | 验收项 | 对应 EARS | 验证方式 |
|---|---|---|---|
| 1 | 重试接口在**执行层**过滤 `hit` / `zero`，不能只靠前端禁用按钮 | #28 | 自动化测试（固定夹具） |
| 2 | `captcha` 状态的 analysis 不得进入自动重试队列 | #10 | 自动化测试 |
| 3 | 服务端校验 `consentAck`，拒绝未确认的 `run-analyses` | #7/#8 | 自动化测试 |
| 4 | 导出列名为数据字段名语义（`线索分`/`分数来源`），非界面标签；界面标签统一"排序分" | #17b | 人工核验 |
| 5 | 分数不使用概率/准确性措辞，**含导出列名与表头** | #17b | 人工核验 |
| 6 | CSV 防公式注入：`=`/`+`/`-`/`@`/制表符/回车开头按文本处理 | #25 | 自动化测试 |
| 7 | 本地服务**仅绑定回环地址**，不得监听局域网/公网 | #24 | 人工核验 |
| 8 | 第三方密钥不写入日志与导出 | #26/#25 | 人工核验 |
| 9 | 遥测默认关闭，关闭态零外发遥测请求 | #23 | 自动化测试 |
| 10 | 四种空状态分别处理，不得复用同一文案 | #27 | 人工核验 |
| 11 | 完全离线时仍可完成本地预检与抽帧 | #26 | 自动化测试 |

**门禁规则**：设计侧 4 项文本扫描（emoji / 真实标签类 / JSON 有效性 / 主题键）与实现侧 11 项**分开计分**。设计侧全绿**不得**被表述为"验收通过"。
