# RVS API 契约文档

> 适用版本：`v1`（本地服务 / 零外部依赖）
> 基础路径：`http://127.0.0.1:4173/api`（默认端口 4173，`RVS_PORT` 可覆盖）
> 端点前缀：**`/api/`**（不带版本段）
> 绑定约束：只监听回环地址（`127.0.0.1` / `localhost` / `::1`）；`RVS_HOST` 非回环时拒绝启动
> 事实来源：`server/routes/*.mjs`。**文档与代码冲突时以代码为准**
> 最后更新：2026-10-24

> ⚠️ 本版为据实现校正后的版本。前一版写作 `/api/v1/` 前缀 + `{code:0}` 信封 + 8787 端口 +
> `pause`/`resume`/`cancel` 三个分立端点，与实现不符；实现是 `/api/` + `{ok,data}` + 4173 +
> `control` 单端点携带 `action`，且多出确认授权、分析矩阵、引擎启停/自测等端点。已全部改正。

---

## 1. 通用约定

### 1.1 请求

| 项 | 约定 |
|---|---|
| 认证 | 无。服务只监听回环地址，不做鉴权 |
| 内容类型 | 除文件上传（`multipart/form-data`）外，一律 `application/json; charset=utf-8` |
| 请求体上限 | 8 MiB，超出抛 `BAD_REQUEST`（`readBody`） |
| 时间格式 | 实体字段（task / frame / analysis / result）为 **epoch 毫秒数字**，如 `1792813979724`；导出 CSV/JSON 的 `discovered_ms`、`generated_at` 为 **ISO 8601 UTC 字符串** |
| ID 格式 | 带语义前缀的短 ID：`rvs_t_*`(task) `rvs_f_*`(frame) `rvs_a_*`(analysis) `rvs_r_*`(result) |
| 布尔传入 | JSON 原生布尔；query string 用 `1` / `0` / `true` / `on` |
| 未知字段 | 忽略，不报错 |

### 1.2 统一响应信封

成功与失败是**两种结构**，用 `ok` 判别（不是靠 `code` 是否为 0）：

成功：

```json
{ "ok": true, "data": { "task": {} } }
```

失败：

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "任务不存在", "detail": { "task_id": "rvs_t_x" } } }
```

- `error.code` 取值见 §1.3；`detail` 是可选结构化上下文，无值时为 `null`
- **`X-Request-Id` 响应头在成功与失败时都存在**，可传给 `GET /api/logs?request_id=` 串联日志
- HTTP 状态码由 `error.code` 经 `ERROR_CODES` 映射；前端先按 HTTP 分支、再按 `error.code` 精确定位
- 未知 `/api/*` 路径：404 + 上述错误信封（`NOT_FOUND`），**不会**回落 SPA HTML
- 非 API 未知路径：带 `Accept: text/html` 的导航请求回落 `index.html`（200，SPA 路由接管）；资产/fetch 类请求返回 404 信封
- 导出端点（`export.csv` / `export.json`）**不走信封**，直接返回文件体 + `Content-Disposition: attachment`

### 1.3 错误码与 HTTP 状态（唯一映射处：`server/lib/errors.mjs`）

| code | HTTP | 含义 | 可自动重试 |
|---|---|---|---|
| `BAD_REQUEST` | 400 | 参数/请求体不合法（JSON 解析失败、缺字段、未知控制动作等） | 否 |
| `CONSENT_REQUIRED` | 400 | 未确认外发授权即发起检索 | 否 |
| `MEDIA_ERROR` | 400 | ffmpeg/ffprobe 预检或抽帧失败 | 否 |
| `CAPTCHA` | 400 | 引擎返回验证码页 | 否（EARS 10 显式排除） |
| `FORBIDDEN` | 403 | 引擎拒绝（凭据/权限） | 是 |
| `NOT_FOUND` | 404 | 任务 / 线索 / 引擎不存在（含已删除任务） | 否 |
| `CONFLICT` | 409 | 状态冲突 | 否 |
| `UPLOAD_REJECTED` | 413 | 上传文件超过 `maxFileBytes` | 否 |
| `PARSE_ERROR` | 422 | 引擎返回页解析不到结果结构 | 是 |
| `RATE_LIMITED` | 429 | 引擎限频（连续触发会熔断） | 是 |
| `PROVIDER_DISABLED` | 503 | 引擎被停用，调度层直接跳过 | 否 |
| `NETWORK_ERROR` | 502 | 网络层失败 | 是 |
| `PROXY_UNREACHABLE` | 502 | 代理不可达 | 是 |
| `TIMEOUT` | 504 | 超时（连接 1s / TLS 3s / 首字节 5s / 整体 15s 预算） | 是 |
| `INTERNAL` | 500 | 未归类异常（不向客户端泄漏细节） | 否 |

> `ZERO_RESULT` 是**成功零命中**，不是错误码，不作为错误抛出。

### 1.4 分页

- 列表端点统一 `limit` / `offset`；`GET /api/results` 的 `limit` 夹在 1–100（默认 20）
- 导出端点不走分页，上限固定 10000 条
- 响应形如 `{ items, total, limit, offset }`

### 1.5 轮询约定

| 场景 | 间隔 | 来源 |
|---|---|---|
| 建任务之后 | `poll_interval_ms` = 3000 | `POST /api/file-upload` 响应 |
| 抽帧进行中 | `poll_interval_ms` = 1000 | `POST /api/tasks/:id/extract` 响应 |
| 分析进行中 | 由任务详情轮询驱动 | 终态：`succeeded` / `zero_result` / `manual` / `failed` / `cancelled` |

### 1.6 静态资源与 SPA 兜底

| 路径 | 行为 |
|---|---|
| `/frames/<task_id>/<file>` | 帧图，缺失 → 404 信封 |
| `/thumbs/<file>` | 缩略图（当前实现不落盘缩略图，故恒为 404） |
| `/` 与未知非 API 路径 + `Accept: text/html` | 回落 `public/index.html`（200） |
| 未知 `/api/*` | 404 JSON 信封 |

---

## 2. 端点清单

| # | 方法 | 路径 | 说明 | 成功码 |
|---|---|---|---|---|
| 1 | POST | `/api/file-upload` | 建任务：multipart 文件 **或** JSON（本地路径 / 公网 URL） | 201 |
| 2 | GET | `/api/tasks` | 任务列表（状态/关键字筛选 + 分页） | 200 |
| 3 | GET | `/api/tasks/:id` | 任务详情 | 200 |
| 4 | POST | `/api/tasks/:id/confirm` | 确认外发授权范围（engines 必选） | 200 |
| 5 | POST | `/api/tasks/:id/extract` | 异步抽帧 | 202 |
| 6 | POST | `/api/tasks/:id/control` | 控制：`pause` / `resume` / `cancel` / `retry-failed` | 200 |
| 7 | DELETE | `/api/tasks/:id` | 删除任务并清理自产帧、结果与上传副本 | 200 |
| 8 | GET | `/api/tasks/:id/frames` | 帧列表（去重分组 + 启用态） | 200 |
| 9 | PATCH | `/api/tasks/:id/frames` | 批量启停帧 | 200 |
| 10 | POST | `/api/search/run-analyses` | 发起检索（服务端强制校验授权与确认） | 202 |
| 11 | GET | `/api/search/analyses/:id` | 单条分析状态与降级日志 | 200 |
| 12 | GET | `/api/tasks/:id/analyses` | 任务的分析矩阵 | 200 |
| 13 | GET | `/api/results` | 结果集（筛选 / 排序 / 分页） | 200 |
| 14 | GET | `/api/results/:id/hits` | 单条线索的证据链 | 200 |
| 15 | GET | `/api/export.csv` | 导出 CSV（BOM + 公式注入防护） | 200 |
| 16 | GET | `/api/export.json` | 导出 JSON（schema 版本 + 免责声明） | 200 |
| 17 | GET | `/api/engines` | 引擎状态聚合 + 图床站点清单 | 200 |
| 18 | PATCH | `/api/engines/:provider` | 引擎启停与检索方式开关 | 200 |
| 19 | GET | `/api/engines/:provider/probe` | 引擎连通性自测（HTTP 恒 200） | 200 |
| 20 | GET | `/api/settings` | 设置：可写项 + 只读镜像 | 200 |
| 21 | PUT | `/api/settings` | 部分更新可写设置 | 200 |
| 22 | GET | `/api/logs` | 结构化日志查询（内存环形缓冲，已脱敏） | 200 |
| 23 | GET | `/api/health` | 进程 / ffmpeg / DB / 代理 / 引擎概览 | 200 |

---

## 3. 端点详细定义

### 3.1 POST /api/file-upload

建任务的**唯一入口**（无独立的 `POST /api/tasks`）。按 `Content-Type` 分流：

- `multipart/form-data`：浏览器 `FormData` 通道（浏览器拿不到本地绝对路径，只能走这条）
- 其他（JSON）：`{ source_type: 'file' | 'url' }`，本地路径或公网 URL

multipart 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `file` | 文件 | 必填；落到 `data/uploads/u_<ts>/` 暂存区 |
| `title` | 文本 | 可选；作为 `display_name`，缺省用原始文件名 |
| `extract_mode` / `max_frames` / `frame_interval_ms` / `scene_threshold` | 文本 | 可选抽帧参数 |

JSON 字段：`source_type`、`source_path`（file 时必填）、`source_url`（url 时必填）、`display_name`、`title`、抽帧参数同上。

响应 `201`：

```json
{ "ok": true, "data": { "task": {}, "plan": { "estimated_frames": 12, "strategy": "interval_plan", "warnings": [] }, "poll_interval_ms": 3000 } }
```

- `plan.warnings` 取值：`duration_too_long` / `low_resolution` / `codec_unusual` / `remote_url_not_public`
- 预检失败（ffprobe 不可用或源不可读）返回 **400 + 错误信封**，便于前端展示 ffmpeg 摘要
- 上传文件超过上限：`UPLOAD_REJECTED`（413）
- multipart 缺文件或缺 `name`：`BAD_REQUEST`

### 3.2 GET /api/tasks

query：`status`、`q`、`limit`、`offset`。响应：`{ items, total, limit, offset }`。

### 3.3 GET /api/tasks/:id

响应：`{ task }`。任务不存在或已删除 → 404（`NOT_FOUND`）。

### 3.4 POST /api/tasks/:id/confirm

请求体：`{ engines: boolean, bridge?: boolean, imagehost?: string }`（也接受 `{ scope: {...} }`）。

- `engines` 必须为 `true`（把帧发到公开搜索引擎），否则 `BAD_REQUEST`
- `bridge` 为 `true` 时必须同时给 `imagehost`（`catbox` / `0x0` / `tmpfiles`），否则 `BAD_REQUEST`
- 响应：`{ task, consent }`

### 3.5 POST /api/tasks/:id/extract

请求体（均可选）：`mode`（`interval` / `scene` / `both`）、`max_frames`、`frame_interval_ms`、`scene_threshold`。

响应 `202`：`{ task_id, status: 'extracting', frame_count, poll_interval_ms: 1000 }`。抽帧在后台跑，前端轮询任务详情。

### 3.6 POST /api/tasks/:id/control

请求体：`{ action: 'pause' | 'resume' | 'cancel' | 'retry-failed' }`。未知动作 → `BAD_REQUEST`（响应 `detail.allowed` 列出可选值）。

> 前一版文档把暂停/继续/取消写成三个分立端点，实现合并为单端点 + `action`。

### 3.7 DELETE /api/tasks/:id

响应：`{ id, deleted: true }`。

删除范围（PRD EARS #20）：帧文件与帧目录、结果/命中/分析 DB 行、孤儿结果、该任务的授权记录（软删除任务行）；
**上传暂存区 `data/uploads/u_*/` 内的源视频副本**一并清除（抽帧后不再被引用，留着即永久泄漏整段视频）。
⚠️ `source_path` 指向 uploads 之外的文件（JSON 建任务时指向用户磁盘原文件）**不删**——那是用户的源视频。

### 3.8 GET /api/tasks/:id/frames

query：`include_duplicates`（默认 `1`；传 `0` 时只返回非重复帧，与服务层去重语义一致）。

响应：`{ items, total }`，每项含 `seq` / `time_ms` / `dhash` / `dup_group` / `is_duplicate` / `enabled` / `url_path`。

### 3.9 PATCH /api/tasks/:id/frames

请求体：`{ frame_ids?: string[], enabled: boolean }`。`frame_ids` 缺省表示对全部帧操作。

### 3.10 POST /api/search/run-analyses

请求体：`task_id`（必填）、`frame_ids`、`providers`、`options`、`consent_ack`。

服务端**强制校验**该任务已确认授权（EARS #20 相关验收项）；未授权 → `CONSENT_REQUIRED`。响应 `202`。

### 3.11 GET /api/search/analyses/:id

响应：`{ analysis }`，含 `status`、`degradation_log`（逐级降级记录）、`manual_path` / `manual_url`（人工兜底态）。

### 3.12 GET /api/tasks/:id/analyses

响应：`{ items, total }`（帧 × 引擎矩阵）。

### 3.13 GET /api/results

query：`task_id`（可逗号分隔多个）、`q`、`domain`、`provider`、`min_score`、`sort`、`order`、`limit`、`offset`。

响应：`{ items, total }`，每条含 `hit_count`、`hits[]`、以及 `similarity_note`
（`local_hash_similarity` 为 `null` 时给出「未提供」说明，避免在界面上伪造相似度）。

### 3.14 GET /api/results/:id/hits

响应：线索详情 + `hits`（哪帧、哪个引擎、第几位命中）+ `frames`（含 `preview_url`）。不存在 → 404。

### 3.15 GET /api/export.csv

query 与 `/api/results` 相同。响应：`text/csv; charset=utf-8` + BOM + `Content-Disposition: attachment`。

- 列名为**数据字段语义**（`线索分` / `分数来源` / `本地哈希相似度`），不是界面标签（界面统一称「排序分」）
- 以 `= + - @ 制表符 回车` 开头的单元格**先判注入再包裹**（前置单引号），防表格公式注入

### 3.16 GET /api/export.json

响应：`application/json`，含 `schema_version`、`app_version`、`generated_at`、`filters`、`total`、`items`，
以及固定的 `score_note` 免责声明（写明分数仅用于排序、**不代表来源真实性概率**，需人工核验）。

### 3.17 GET /api/engines

响应：`{ engines: [...], imagehost: { ..., hosts: [...] } }`。每个引擎含
`id` / `label` / `enabled` / `availability`（`deeplink` / `upload` / `bridge`，取值 `verified` / `unverified` / `unavailable`）、
`notes`、`entry_url`、熔断字段（`circuit_open` / `circuit_remaining_sec` / `consecutive_failures`）与 `modes`（当前开关）。

> 可用性以 live 数据为准，会随引擎侧改版变化；前端「引擎诊断」页渲染同一份数据。

### 3.18 PATCH /api/engines/:provider

请求体：`enabled`（布尔）与/或 `deeplink` / `upload`（布尔）。三者皆无 → `BAD_REQUEST`。引擎不存在 → 404。

### 3.19 GET /api/engines/:provider/probe

连通性自测。**HTTP 恒 200**，可达性体现在 `data` 里（失败也在 `data` 中表达）。引擎不存在 → 404。

### 3.20 GET /api/settings

响应：`{ writable, read_only }`。`read_only` 是运行时镜像（服务端口、ffmpeg 路径、日志目录、网络预算等，不可改）；
`writable` 含 `extract` / `engines` / `imagehost` / `similarity` / `export`。**密钥类字段一律脱敏**。

### 3.21 PUT /api/settings

请求体为部分更新对象，空对象 → `BAD_REQUEST`。响应：`{ writable }`（更新后的完整可写项）。

### 3.22 GET /api/logs

query：`level`、`category`、`since`、`until`、`q`、`request_id`、`task_id`、`event`、`limit`、`offset`。

日志为内存环形缓冲 + 按天 `jsonl` 落盘（`data/logs/rvs-<day>.jsonl`，受保留期约束）。日志正文**已脱敏**（不记录帧内容、源视频路径、来源页正文、IP）。

### 3.23 GET /api/health

响应：`status` / `pid` / `uptime_ms` / `node_version` / `sqlite` / `db` / `ffmpeg`（可用性与版本行）/
`proxy`（配置与可达性，缓存 30s）/`offline` / `host` / `port` / `engines`（精简列表）。

---
## 4. 数据库设计

> 本节保留原设计说明。注意：`results` 表本身即**去重后**的结果集（按 `canonical_url` 唯一），
> 因此 `GET /api/results` 没有、也不需要 `dedupe` 参数；原稿提到的 `dedupe=0/1` 两种查询形态
> 属于设计期设想，当前实现只走去重结果集，证据明细改由 `GET /api/results/:id/hits` 提供。

### 4.1 ER 关系

```
                 ┌──────────────────┐
                 │      tasks       │
                 └────────┬─────────┘
                          │ 1
              ┌───────────┴───────────┐
              │ N                     │ N
     ┌────────▼─────────┐             │
     │      frames      │             │
     └────────┬─────────┘             │
              │ 1                     │
              │ N                     │
     ┌────────▼────────────────────┐  │
     │          analyses           │◄─┘  (冗余 task_id 便于聚合查询)
     └────────┬────────────────────┘
              │ N
              │                      ┌───────────────────────────┐
              └──────►  result_hits  │  证据关系表                │
                       (evidence)    │  analysis_id + result_id  │
                              N ┌────┴───────────────────────────┘
                                │ 1
                       ┌────────▼──────────────────────┐
                       │            results            │
                       │  去重后的规范结果（canonical）  │
                       └───────────────────────────────┘

     独立表：engine_health（引擎状态机）  settings（键值配置）
             _migrations（迁移版本）
```

**为什么 `results` 是去重后的表**：同一个 URL 被 3 帧 × 2 引擎命中时，`results` 只有 1 行，`result_hits` 有 6 行。`result_hits` 是纯证据关系表，承载"谁在什么时候、以什么位次命中了它"。这样 `GET /api/results` 的 `dedupe=1` 查询就在 `results` 上做，`dedupe=0` 就在 `result_hits` 上做，两条查询都不需要 `GROUP BY`。

`results` 之外的"这一次分析本身的元信息"（引擎结果页 URL、HTTP 状态码、解析策略）放在 `analyses` 表上，不额外建表。

### 4.2 tasks

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | `rvs_t_*` |
| `source_type` | TEXT | NOT NULL | `file` / `url` / `url_image` |
| `source_ref` | TEXT | NOT NULL | 本地绝对路径或远程 URL |
| `title` | TEXT | NOT NULL DEFAULT '' | |
| `duration_ms` | INTEGER | NULL | ffprobe 输出 |
| `width` / `height` | INTEGER | NULL | |
| `r_frame_rate` | TEXT | NULL | 形如 `15/1` |
| `codec_name` | TEXT | NULL | |
| `status` | TEXT | NOT NULL DEFAULT 'created' | `created`/`probing`/`ready`/`frames_ready`/`extracting`/`analyzing`/`paused`/`done`/`cancelled`/`failed` |
| `extract_mode` | TEXT | DEFAULT 'scene' | `interval`/`scene`/`both` |
| `frame_interval_ms` | INTEGER | DEFAULT 1500 | |
| `scene_threshold` | REAL | DEFAULT 0.25 | |
| `max_frames` | INTEGER | DEFAULT 12 | |
| `hash_hamming_threshold` | INTEGER | DEFAULT 6 | |
| `frame_count` | INTEGER | DEFAULT 0 | |
| `analyzed_frame_count` | INTEGER | DEFAULT 0 | |
| `result_hit_count` | INTEGER | DEFAULT 0 | |
| `public_url` | TEXT | NULL | 公网可达的输入 URL，deeplink 免图床的来源 |
| `imagehost_consent` | INTEGER | DEFAULT 0 | 用户是否对本任务确认过图床桥接 |
| `error_code` | TEXT | NULL | |
| `error_message` | TEXT | NULL | |
| `created_at` / `updated_at` / `deleted_at` | TEXT | NOT NULL / NULL | ISO 8601 |

**索引**：`idx_tasks_status_updated (status, updated_at DESC)`、`idx_tasks_created (created_at DESC)`、`idx_tasks_deleted (deleted_at)`。

### 4.3 frames

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | `rvs_f_*` |
| `task_id` | TEXT | NOT NULL, FK → tasks.id ON DELETE CASCADE | |
| `seq` | INTEGER | NOT NULL | 帧在任务内的序号，从 1 起 |
| `pts_ms` | INTEGER | NOT NULL | 时间点 |
| `file_path` | TEXT | NOT NULL | 相对 `data/` 的路径 |
| `thumb_path` | TEXT | NULL | |
| `width` / `height` | INTEGER | NULL | |
| `size_bytes` | INTEGER | DEFAULT 0 | |
| `dhash` | TEXT | NULL | 16 位十六进制，64 bit dHash |
| `dhash_group` | INTEGER | NULL | 同组表示汉明距离 ≤ 阈值 |
| `is_duplicate` | INTEGER | DEFAULT 0 | |
| `selected` | INTEGER | DEFAULT 1 | 是否纳入默认分析范围 |
| `scene_score` | REAL | NULL | scene 模式下 ffmpeg 给出的场景分数 |
| `source_url` | TEXT | NULL | 图床桥接产出的公网 URL（若已产生） |
| `created_at` | TEXT | NOT NULL | |

**唯一**：`uniq_frames_task_seq (task_id, seq)`
**索引**：`idx_frames_task_selected (task_id, selected)`、`idx_frames_task_dhash_group (task_id, dhash_group)`、`idx_frames_dhash (dhash)`。

### 4.4 analyses

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | `rvs_a_*` |
| `task_id` | TEXT | NOT NULL, FK → tasks.id ON DELETE CASCADE | 冗余，便于按任务聚合 |
| `frame_id` | TEXT | NOT NULL, FK → frames.id ON DELETE CASCADE | |
| `engine_id` | TEXT | NOT NULL | `google_lens` / `yandex` / `bing` |
| `status` | TEXT | NOT NULL DEFAULT 'queued' | `queued`/`running`/`succeeded`/`zero_result`/`manual`/`failed`/`cancelled` |
| `attempt_mode` | TEXT | NULL | 最终采用的方式：`upload`/`deeplink`/`bridge`/`manual` |
| `request_url` | TEXT | NULL | 实际发出的 URL（deeplink 模式下含编码后的图片 URL） |
| `http_status` | INTEGER | NULL | |
| `latency_ms` | INTEGER | NULL | |
| `hit_count` | INTEGER | DEFAULT 0 | |
| `error_code` | TEXT | NULL | 见 §1.4 |
| `error_message` | TEXT | NULL | 面向用户的可读描述 |
| `result_url` | TEXT | NULL | 该引擎的结果页地址，供用户"在引擎中打开" |
| `result_page_meta` | TEXT | NULL | JSON：结果页的元信息快照（标题、命中元素的粗略数量等），不含第三方正文内容 |
| `parse_strategy` | TEXT | NULL | 实际采用的 HTML 片段提取策略标识，用于复盘 `PARSE_ERROR` |
| `raw_retained` | INTEGER | DEFAULT 0 | 是否保留了原始响应片段（仅 debug 模式） |
| `degradation_log` | TEXT | NULL | JSON 数组：`[{level, mode, error_code, http_status, skipped_reason, at}]` |
| `retain_raw_path` | TEXT | NULL | 仅 debug 模式下有值，指向 `cache/html/` |
| `imagehost_url` | TEXT | NULL | 若走了 bridge，记录图床返回的 URL |
| `started_at` / `finished_at` | TEXT | NULL | |
| `created_at` / `updated_at` | TEXT | NOT NULL | |

**唯一**（部分索引，SQLite 支持 `WHERE` 子句）：

```sql
CREATE UNIQUE INDEX uniq_analyses_live
  ON analyses(frame_id, engine_id)
  WHERE status NOT IN ('cancelled');
```

**索引**：`idx_analyses_task_status (task_id, status)`、`idx_analyses_status_created (status, created_at)`、`idx_analyses_engine_status (engine_id, status)`。

### 4.5 results（去重后的规范结果）

这是 `GET /api/results` 在 `dedupe=1` 时直接读取的表。一行代表一个"网络上的规范目标"，`canonical_url` 唯一。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | `rvs_r_*` |
| `canonical_url` | TEXT | NOT NULL UNIQUE | 归一化后的 URL（小写 host、去尾斜杠、去 `utm_*` 等追踪参数、去 `#`） |
| `normalized_host` | TEXT | NOT NULL | 即 API 响应中的 `domain` |
| `title` | TEXT | NULL | |
| `snippet` | TEXT | NULL | |
| `thumb_url` | TEXT | NULL | 指向原站；服务端**不代理下载**第三方图片 |
| `best_score` | REAL | NULL | 禁止无来源填充 |
| `score_source` | TEXT | NOT NULL DEFAULT 'none' | `engine_provided`/`local_normalized`/`none` |
| `engine_rank_best` | INTEGER | NULL | 最好的引擎返回位次，从 1 起 |
| `local_similarity` | REAL | NULL | 本地哈希相似度 0.0 - 1.0 |
| `hit_count` | INTEGER | DEFAULT 0 | 证据条数 |
| `engine_count` | INTEGER | DEFAULT 0 | 命中的引擎数 |
| `frame_count` | INTEGER | DEFAULT 0 | 命中的帧数 |
| `first_seen_at` / `last_seen_at` | TEXT | NOT NULL | |
| `created_at` / `updated_at` | TEXT | NOT NULL | |

**索引**：`idx_results_host (normalized_host)`、`idx_results_best_score (best_score DESC)`、`idx_results_last_seen (last_seen_at DESC)`、`idx_results_hits (hit_count DESC)`。

### 4.6 result_hits（证据关系）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | `rvs_rh_*` |
| `result_id` | TEXT | NOT NULL, FK → results.id ON DELETE CASCADE | 指向去重后的规范结果 |
| `analysis_id` | TEXT | NOT NULL, FK → analyses.id ON DELETE CASCADE | 指向产生该证据的分析作业 |
| `task_id` / `frame_id` / `engine_id` | TEXT | NOT NULL | 冗余便于筛选与 facets |
| `source_url` | TEXT | NOT NULL | 原始链接（保留追踪参数，用于溯源） |
| `title` | TEXT | NULL | 该次命中处的标题，可能与规范结果不同 |
| `snippet` | TEXT | NULL | |
| `thumb_url` | TEXT | NULL | |
| `engine_position` | INTEGER | NULL | 引擎返回结果中的位次，从 1 起 |
| `engine_score` | REAL | NULL | 仅当引擎真实返回数值时有值 |
| `score_source` | TEXT | NOT NULL DEFAULT 'none' | 同上三种取值 |
| `local_similarity` | REAL | NULL | |
| `evidence_type` | TEXT | DEFAULT 'web_page' | `web_page` / `image` / `video` |
| `created_at` | TEXT | NOT NULL | |

**唯一**：`uniq_hits_analysis_result (analysis_id, result_id)`
**索引**：`idx_hits_result (result_id)`、`idx_hits_task_engine (task_id, engine_id)`、`idx_hits_frame (frame_id)`、`idx_hits_position (engine_position)`。

### 4.7 engine_health

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | `rvs_eh_*` |
| `engine_id` | TEXT | NOT NULL UNIQUE | |
| `display_name` | TEXT | NOT NULL | |
| `enabled` | INTEGER | DEFAULT 1 | 用户总开关 |
| `deeplink_supported` | INTEGER | DEFAULT 1 | |
| `deeplink_verification` | TEXT | DEFAULT 'unverified' | `verified`/`partial`/`unverified` |
| `upload_supported` | INTEGER | DEFAULT 1 | |
| `upload_verification` | TEXT | DEFAULT 'unverified' | |
| `upload_mode_default_on` | INTEGER | DEFAULT 0 | 实验性，默认 0 |
| `circuit_state` | TEXT | DEFAULT 'closed' | `closed`/`open`/`half_open` |
| `circuit_until` | INTEGER | NULL | epoch ms |
| `consecutive_failures` | INTEGER | DEFAULT 0 | |
| `last_probe_at` | TEXT | NULL | |
| `last_http_status` | INTEGER | NULL | |
| `last_latency_ms` | INTEGER | NULL | |
| `last_error_code` | TEXT | NULL | |
| `last_success_at` | TEXT | NULL | |
| `notes` | TEXT | NULL | 面向用户展示的验证状态说明 |
| `updated_at` | TEXT | NOT NULL | |

**索引**：`idx_engine_health_circuit (circuit_state, circuit_until)`。

### 4.8 settings

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `key` | TEXT | PK | 点分命名空间，如 `extract.mode` |
| `value` | TEXT | NOT NULL | JSON 编码的标量 / 数组 / 对象 |
| `value_type` | TEXT | NOT NULL | `string`/`integer`/`real`/`boolean`/`array` |
| `source` | TEXT | NOT NULL DEFAULT 'user' | `env`/`default`/`user`；`env` 不可编辑 |
| `updated_at` | TEXT | NOT NULL | |

### 4.9 _migrations

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | INTEGER PK | 单调递增 |
| `name` | TEXT NOT NULL | |
| `applied_at` | TEXT NOT NULL | |

### 4.10 表清单总览

| 表 | 粒度 | 一个任务典型行数 | 主读端点 |
|---|---|---|---|
| `tasks` | 一次用户提交 | 1 | `GET /api/tasks`、`GET /api/tasks/:id` |
| `frames` | 任务下的一帧 | 4 - 60 | `GET /api/tasks/:id/frames` |
| `analyses` | 帧 × 引擎 | 帧数 × 引擎数（≤ 3） | `GET /api/search/analyses/:id` |
| `results` | 去重后的规范目标 | 命中 URL 数 | `GET /api/results`（`dedupe=1`） |
| `result_hits` | 一次分析的一条命中证据 | analyses 数 × 每次命中数 | `GET /api/results`（`dedupe=0`）、facets |
| `engine_health` | 一个引擎一行 | 3 | `GET /api/engines`、`GET /api/health` |
| `settings` | 一个配置键一行 | 约 20 | `GET /api/settings` |

### 4.11 索引策略说明

MVP 阶段只建立上文中列出的索引，遵循三条原则：

1. 高频查询的外键字段必建（`task_id`、`frame_id`、`analysis_id`）。
2. 排序字段建索引（`best_score DESC`、`last_seen_at DESC`、`updated_at DESC`）。
3. **不建复合优化索引**，等出现慢查询再补。唯一例外是 `idx_tasks_status_updated`，因为任务列表页是首屏且必然带 `status` 过滤。

### 4.12 迁移规程

- 启动时自动执行 `migrate.mjs`，进程内串行执行未应用的迁移，全部在同一事务内完成。
- 迁移必须幂等：使用 `CREATE TABLE IF NOT EXISTS` 与 `_migrations` 版本号双重保护。
- MVP 禁止破坏性迁移（DROP COLUMN / 重写表）。结构变更一律走新增列 + 双写 + 后续清理。

---

## 5. 相似性约定的落地检查点

以下三条若被违反，视为实现缺陷：

1. 任何出现在 UI 上的相似度数字，其相邻位置必须能看到来源标注（引擎提供 / 本地归一 / 无分数）。
2. `score_source = 'none'` 时，`best_score` 必须为 `null`，UI 不得用 `0` 或占位符代替。
3. 不得把 `local_similarity` 与 `engine_score` 混合计算后当作单一"综合置信度"展示。两者可以同时并列展示，但必须各自标注。
