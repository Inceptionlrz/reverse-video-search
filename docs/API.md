# RVS API 契约文档

> 适用版本：`v1`
> 基础路径：`http://127.0.0.1:8787`
> 所有端点均带前缀 **`/api/v1/`**
> 状态：决策已锁定，前后端据此联调
> 最后更新：2026-10-24

---

## 1. 通用约定

### 1.1 请求

| 项 | 约定 |
|---|---|
| 认证 | 无。服务只监听回环地址，不做鉴权 |
| 内容类型 | 除文件上传外，一律 `application/json; charset=utf-8` |
| 时间格式 | ISO 8601 UTC，毫秒精度，例如 `2026-10-24T08:15:30.000Z` |
| ID 格式 | 带语义前缀的短 ID：`rvs_t_*`(task) `rvs_f_*`(frame) `rvs_a_*`(analysis) `rvs_r_*`(result) |
| 布尔传入 | JSON 原生布尔（`true` / `false`），除 query string 中使用 `1` / `0` |
| 未知字段 | 忽略，不报错（便于后续向前兼容） |

### 1.2 统一响应信封

成功与失败共用同一结构，业务状态码放在 `code`：

```json
{
  "code": 0,
  "message": "ok",
  "data": {},
  "request_id": "rvs_req_01JCK9X2M4"
}
```

- `code = 0` 表示成功；非 0 见 §1.4
- HTTP 状态码与 `code` 一一映射，前端以 HTTP 状态码做分支，`code` 用于精确定位
- `request_id` 同时出现在响应头 `X-Request-Id`，用于与 `GET /api/v1/logs` 关联

### 1.3 分页

所有返回列表的端点统一：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [],
    "total": 128,
    "page": 1,
    "limit": 20,
    "hasMore": true
  }
}
```

`page` 从 1 开始，`limit` 默认 20，最大 100。超出范围返回空 `items`，不报错。

### 1.4 全局错误码

| HTTP | code | 含义 | 前端处理 |
|---|---|---|---|
| 400 | `BAD_REQUEST` | 参数缺失或格式错误 | 表单内提示 |
| 400 | `MEDIA_ERROR` | ffprobe / ffmpeg 非零退出，文件无法解析 | 提示"无法解析该文件（可能不是视频或已损坏）" |
| 400 | `CAPTCHA` | 引擎要求人机校验 | 见降级链路，自动转入手工模式 |
| 401 / 403 | `FORBIDDEN` | 引擎拒绝访问 | 自动降级，禁用该引擎的可重试提示 |
| 404 | `NOT_FOUND` | 资源不存在 | 返回任务列表 |
| 409 | `CONFLICT` | 状态不允许该动作（如任务已取消仍调用 resume；重复抽帧） | 展示当前状态，禁用按钮 |
| 413 | `UPLOAD_REJECTED` | 引擎或图床拒绝直传（含体积过大） | 自动降级到 deeplink / manual |
| 429 | `RATE_LIMITED` | 引擎限流 | 自动退避重试，UI 显示"引擎限流中" |
| 500 | `INTERNAL` | 未捕获异常 | 展示 `request_id` 便于查日志 |
| 502 | `NETWORK_ERROR` | DNS / CONNECT / TLS / socket 提前关闭 | 提示检查代理，自动降级 |
| 504 | `TIMEOUT` | 任意阶段超时 | 自动重试一次后降级 |
| 422 | `PARSE_ERROR` | 引擎返回 200 但无法提取结构 | 提示"引擎响应格式已变化"，自动降级 |
| 200 | `ZERO_RESULT` | 成功执行但零命中 | **不作为错误处理**，UI 显示"未找到匹配结果" |
| 503 | `PROVIDER_DISABLED` | 引擎被用户关闭或已熔断 | 直接进手工模式，UI 说明原因 |

> `ZERO_RESULT` 是唯一一个 HTTP 200 + `code != 0` 的组合。前端必须先判断 HTTP 状态码，再判断 `code`，避免把它渲染成错误。

### 1.5 轮询约定

本服务**不使用 SSE / WebSocket**。前端轮询 `GET /api/v1/tasks/:id`，轮询间隔由后端在响应的 `data.poll_interval_ms` 下发（运行中 1000ms，空闲 3000ms）。前端不得硬编码轮询间隔。

---

## 2. 端点清单

| # | Method | Path | 功能 |
|---|---|---|---|
| 1 | POST | `/api/v1/file-upload` | 上传本地视频文件或提交远程 URL，创建任务并执行预检 |
| 2 | POST | `/api/v1/search/run-analyses` | 为指定帧 × 指定引擎启动分析作业 |
| 3 | GET | `/api/v1/search/analyses/:id` | 查询单个分析作业的状态与结果 |
| 4 | POST | `/api/v1/tasks/:id/frames/extract` | 启动抽帧（幂等性受状态约束） |
| 5 | GET | `/api/v1/tasks` | 任务列表（筛选 / 排序 / 分页） |
| 6 | GET | `/api/v1/tasks/:id` | 任务详情（含进度与推荐默认工作区） |
| 7 | DELETE | `/api/v1/tasks/:id` | 软删除任务及其帧文件与产物 |
| 8 | GET | `/api/v1/tasks/:id/frames` | 该任务的帧列表（含去重标记与哈希） |
| 9 | POST | `/api/v1/tasks/:id/pause` | 暂停 |
| 10 | POST | `/api/v1/tasks/:id/resume` | 恢复 |
| 11 | POST | `/api/v1/tasks/:id/cancel` | 取消（保留已完成结果） |
| 12 | GET | `/api/v1/results` | 结果列表（跨任务去重 / 筛选 / 排序） |
| 13 | GET | `/api/v1/export.csv` | 导出 CSV |
| 14 | GET | `/api/v1/export.json` | 导出 JSON |
| 15 | GET | `/api/v1/engines/health` | 三家引擎健康状态与接入方式可用性 |
| 16 | GET | `/api/v1/settings` | 读取设置（含脱敏说明） |
| 17 | PUT | `/api/v1/settings` | 更新设置（部分更新） |
| 18 | GET | `/api/v1/logs` | 运行日志查询 |

---

## 3. 端点详细定义

### 3.1 POST /api/v1/file-upload

**功能**：创建任务的唯一入口。接受两种输入：本地文件 multipart 上传，或远程 URL。完成后同步执行预检（ffprobe 取元数据 / URL 侧探测 Content-Type），返回任务 ID 与推荐的抽帧方案。

**Content-Type**：`multipart/form-data`（文件）或 `application/json`（URL）。

**请求体 — 文件形态**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | file | 与 `url` 二选一 | 视频文件二进制，单份 ≤ 2 GB |
| `title` | string | 否 | 缺省时取文件名 |
| `extract_mode` | string | 否 | `interval` / `scene` / `both`，默认 `scene` |
| `frame_interval_ms` | integer | 否 | 默认 `1500`，仅 interval/both 生效 |
| `scene_threshold` | real | 否 | 默认 `0.25`，仅 scene/both 生效 |
| `max_frames` | integer | 否 | 默认 `12`，上限 `60` |
| `engine_ids` | string[] | 否 | 默认全部已启用引擎 |

**请求体 — URL 形态**

```json
{
  "url": "https://example.com/clip.mp4",
  "title": "素材 01",
  "extract_mode": "scene",
  "scene_threshold": 0.25,
  "max_frames": 12,
  "engine_ids": ["google_lens", "yandex", "bing"]
}
```

若远程 URL 的响应 `Content-Type` 为 `image/*`，则跳过抽帧，直接生成 1 个 frame（`source_type='url_image'`）。

**响应体 201**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "task": {
      "id": "rvs_t_01JCK9X2M4TZ3EBQXV",
      "source_type": "file",
      "source_ref": "D:/media/clip.mp4",
      "title": "素材 01",
      "status": "ready",
      "duration_ms": 6000,
      "width": 320,
      "height": 180,
      "r_frame_rate": "15/1",
      "codec_name": "h264",
      "extract_mode": "scene",
      "scene_threshold": 0.25,
      "max_frames": 12,
      "frame_count": 0,
      "analyzed_frame_count": 0,
      "created_at": "2026-10-24T08:15:30.000Z",
      "updated_at": "2026-10-24T08:15:31.204Z"
    },
    "plan": {
      "estimated_frames": 4,
      "strategy": "scene_candidates:4",
      "warnings": []
    },
    "poll_interval_ms": 1000
  }
}
```

**plan.warnings 可能出现的取值**

| 值 | 含义 |
|---|---|
| `duration_too_long` | 超过建议时长，已按 `max_frames` 抽样 |
| `low_resolution` | 分辨率低于 240p，命中率可能偏低 |
| `codec_unusual` | 非常见编码，抽帧可能失败 |
| `remote_url_not_public` | URL 疑似内网地址，deeplink 模式不可用 |

**错误码**：`400 BAD_REQUEST`（`file` 与 `url` 同时缺失或同时提供）、`400 MEDIA_ERROR`（ffprobe 失败）、`404 NOT_FOUND`（远程 URL 不可达，归类为 `NETWORK_ERROR` 时 HTTP 502）。

---

### 3.2 POST /api/v1/tasks/:id/frames/extract

**功能**：启动抽帧。产出帧文件、计算 dHash、执行帧内去重，写 `frames` 表。

**请求体**

```json
{
  "extract_mode": "scene",
  "frame_interval_ms": 1500,
  "scene_threshold": 0.25,
  "max_frames": 12,
  "include_duplicates": false
}
```

全部字段可选；省略则沿用任务创建时的值。`include_duplicates = true` 时保留汉明距离 ≤ 6 的重复帧，但仍标记 `is_duplicate`。

**响应体 202**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "task_id": "rvs_t_01JCK9X2M4TZ3EBQXV",
    "status": "extracting",
    "frame_count": 0,
    "poll_interval_ms": 1000
  }
}
```

抽帧为**异步**过程：返回 202 后前端轮询 `GET /api/v1/tasks/:id`，直到 `status` 变为 `frames_ready`。

**错误码**：`404 NOT_FOUND`、`409 CONFLICT`（任务已在 `extracting` / `analyzing` / `done` 状态）、`400 MEDIA_ERROR`（ffmpeg 非零退出，`data` 携带 ffmpeg 最后 20 行 stderr 摘要）。

---

### 3.3 GET /api/v1/tasks/:id/frames

**功能**：列出该任务的帧，供用户在启动分析前勾选范围。

**Query**：`include_duplicates=0|1`（默认 0）、`page`、`limit`。

**响应体 200**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [
      {
        "id": "rvs_f_01JCK9X2M4TZ3EBQXY",
        "task_id": "rvs_t_01JCK9X2M4TZ3EBQXV",
        "seq": 1,
        "pts_ms": 2000,
        "width": 320,
        "height": 180,
        "size_bytes": 18422,
        "dhash": "9c6e3b1a4f8270d5",
        "dhash_group": 1,
        "is_duplicate": 0,
        "selected": 1,
        "scene_score": 0.61,
        "preview_url": "/api/v1/files/frames/rvs_t_01JCK9X2M4TZ3EBQXV/001_2000.jpg",
        "created_at": "2026-10-24T08:15:36.000Z"
      }
    ],
    "total": 4,
    "page": 1,
    "limit": 20,
    "hasMore": false
  }
}
```

`preview_url` 指向本地静态帧文件，用于浏览器直接 `<img>` 加载；不经过第三方。

**错误码**：`404 NOT_FOUND`。

---

### 3.4 POST /api/v1/search/run-analyses

**功能**：提交分析作业。每个「帧 × 引擎」组合成为一条 `analyses` 记录，进入队列并按 ARCHITECTURE §5 的四级降级链路执行。

**请求体**

```json
{
  "task_id": "rvs_t_01JCK9X2M4TZ3EBQXV",
  "frame_ids": ["rvs_f_01JCK9X2M4TZ3EBQXY", "rvs_f_01JCK9X2M4TZ3EBQXZ"],
  "engine_ids": ["google_lens", "yandex", "bing"],
  "options": {
    "allow_upload": false,
    "allow_imagehost": false,
    "public_url": null
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `task_id` | string | 是 | 目标任务 |
| `frame_ids` | string[] | 否 | 省略表示所有 `selected = 1` 的帧 |
| `engine_ids` | string[] | 否 | 省略表示所有已启用引擎 |
| `options.allow_upload` | boolean | 否 | **默认 false**。实验性 multipart 直传，见 ARCHITECTURE §4 |
| `options.allow_imagehost` | boolean | 否 | **默认 false**。图床桥接，需用户显式开启 |
| `options.public_url` | string\|null | 否 | 任务自带的公网图片/视频 URL，用于 deeplink |

若任务 `source_type = 'url'` 且来源 URL 公网可达，后端自动把它填入 `public_url`，`deeplink` 可直接工作，无需图床。

**响应体 202**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "task_id": "rvs_t_01JCK9X2M4TZ3EBQXV",
    "status": "analyzing",
    "analyses": [
      {
        "id": "rvs_a_01JCK9X2M4TZ3EBQYA",
        "frame_id": "rvs_f_01JCK9X2M4TZ3EBQXY",
        "engine_id": "google_lens",
        "status": "queued",
        "attempt_mode": null,
        "reused": false
      },
      {
        "id": "rvs_a_01JCK9X2M4TZ3EBQYB",
        "frame_id": "rvs_f_01JCK9X2M4TZ3EBQXY",
        "engine_id": "bing",
        "status": "queued",
        "attempt_mode": null,
        "reused": true
      }
    ],
    "queued_count": 6,
    "estimated_seconds": 42,
    "poll_interval_ms": 1000
  }
}
```

同一 `(frame_id, engine_id)` 在该任务生命周期内已有非 `cancelled` 的 analysis 时，不新建，直接返回原记录并标记 `reused: true`。

**错误码**：`404 NOT_FOUND`、`409 CONFLICT`（任务未完成抽帧；或任务已取消）、`400 BAD_REQUEST`（`engine_ids` 含未知引擎）。

---

### 3.5 GET /api/v1/search/analyses/:id

**功能**：查询单个分析作业的最终状态、实际采用的接入方式、降级轨迹与命中的结果。

**响应体 200（成功用例）**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": "rvs_a_01JCK9X2M4TZ3EBQYA",
    "task_id": "rvs_t_01JCK9X2M4TZ3EBQXV",
    "frame_id": "rvs_f_01JCK9X2M4TZ3EBQXY",
    "engine_id": "google_lens",
    "status": "succeeded",
    "attempt_mode": "deeplink",
    "request_url": "https://lens.google.com/uploadbyurl?url=https%3A%2F%2Fexample.com%2Ff.jpg",
    "http_status": 200,
    "latency_ms": 3184,
    "hit_count": 7,
    "error_code": null,
    "error_message": null,
    "degradation_log": [],
    "result": {
      "result_id": "rvs_r_01JCK9X2M4TZ3EBQYC",
      "result_url": "https://lens.google.com/search?ep=...",
      "hits": [
        {
          "canonical_url": "https://www.example-site.com/post/123",
          "title": "示例文章标题",
          "snippet": "包含该画面的原始报道",
          "engine_position": 1,
          "engine_score": null,
          "score_source": "local_normalized",
          "best_score": 1.0,
          "local_similarity": null
        }
      ]
    },
    "started_at": "2026-10-24T08:16:02.000Z",
    "finished_at": "2026-10-24T08:16:05.184Z"
  }
}
```

**响应体 200（降级到手工模式）**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": "rvs_a_01JCK9X2M4TZ3EBQYD",
    "engine_id": "bing",
    "status": "manual",
    "attempt_mode": "manual",
    "hit_count": 0,
    "error_code": "UPLOAD_REJECTED",
    "error_message": "直传被拒绝，且本地帧无公网 URL，已转入手工检索",
    "degradation_log": [
      { "level": 1, "mode": "upload",    "error_code": "UPLOAD_REJECTED", "http_status": 413, "at": "2026-10-24T08:16:02.100Z" },
      { "level": 2, "mode": "deeplink",  "error_code": null,              "skipped_reason": "no_public_url", "at": "2026-10-24T08:16:02.101Z" },
      { "level": 3, "mode": "bridge",    "error_code": null,              "skipped_reason": "imagehost_disabled", "at": "2026-10-24T08:16:02.101Z" }
    ],
    "manual": {
      "frame_file_path": "D:/Project/00_workbuddy/reverse-video-search/data/frames/rvs_t_01JCK9X2M4TZ3EBQXV/001_2000.jpg",
      "open_page_url": "https://www.bing.com/visualsearch",
      "instruction": "已把该帧保存到本地，点击打开 Bing 上传页后手动拖入"
    }
  }
}
```

**status 取值语义**

| status | 含义 | 对应 `code` |
|---|---|---|
| `queued` | 排队中 | 0 |
| `running` | 执行中 | 0 |
| `succeeded` | 有命中 | 0 |
| `zero_result` | 成功但零命中 | 0，但 `data.result.hits` 为空，且在 UI 显示为"未找到匹配结果" |
| `manual` | 已转入手工模式 | 0 |
| `failed` | 未预期错误终止 | 对应错误码 |
| `cancelled` | 用户取消 | 0 |

> `zero_result` 与 `manual` 都是**业务流程的正常终点**，HTTP 200 + `code = 0`。只有 `failed` 才使用非 0 的 `code`。

**错误码**：`404 NOT_FOUND`。

---

### 3.6 GET /api/v1/tasks

**功能**：任务列表。

**Query**

| 参数 | 类型 | 说明 |
|---|---|---|
| `status` | string | 逗号分隔，如 `running,paused` |
| `q` | string | 按 `title` / `source_ref` 模糊匹配 |
| `source_type` | string | `file` / `url` / `url_image` |
| `sort` | string | `created_at` / `updated_at` / `title`，默认 `updated_at` |
| `order` | string | `asc` / `desc`，默认 `desc` |
| `page` / `limit` | integer | 分页 |

**响应体 200**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [
      {
        "id": "rvs_t_01JCK9X2M4TZ3EBQXV",
        "title": "素材 01",
        "source_type": "file",
        "status": "analyzing",
        "duration_ms": 6000,
        "width": 320,
        "height": 180,
        "frame_count": 4,
        "analyzed_frame_count": 2,
        "result_hit_count": 17,
        "progress": { "analyses_total": 12, "analyses_done": 8, "percent": 66 },
        "created_at": "2026-10-24T08:15:30.000Z",
        "updated_at": "2026-10-24T08:16:40.000Z"
      }
    ],
    "total": 3, "page": 1, "limit": 20, "hasMore": false
  }
}
```

**错误码**：无业务错误，参数非法一律回落默认值而非报错。

---

### 3.7 GET /api/v1/tasks/:id

**功能**：任务详情，含进度、推荐默认工作区（默认勾选未去重帧 × 已启用引擎）、最近错误摘要。

**响应体 200**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": "rvs_t_01JCK9X2M4TZ3EBQXV",
    "title": "素材 01",
    "source_type": "file",
    "source_ref": "D:/media/clip.mp4",
    "status": "frames_ready",
    "duration_ms": 6000,
    "width": 320, "height": 180,
    "r_frame_rate": "15/1",
    "codec_name": "h264",
    "extract_mode": "scene",
    "scene_threshold": 0.25,
    "max_frames": 12,
    "frame_count": 4,
    "analyzed_frame_count": 0,
    "result_hit_count": 0,
    "progress": { "analyses_total": 0, "analyses_done": 0, "percent": 0 },
    "default_selection": {
      "frame_ids": ["rvs_f_01JCK9X2M4TZ3EBQXY", "rvs_f_01JCK9X2M4TZ3EBQXZ"],
      "engine_ids": ["google_lens", "yandex"]
    },
    "recent_errors": [],
    "poll_interval_ms": 3000,
    "created_at": "2026-10-24T08:15:30.000Z",
    "updated_at": "2026-10-24T08:15:52.000Z"
  }
}
```

`default_selection.engine_ids` 只包含**当前未熔断且未被用户禁用**的引擎；`bing` 在未验证形态下仍列出，但在 UI 上有"部分验证"角标。

**错误码**：`404 NOT_FOUND`。

---

### 3.8 DELETE /api/v1/tasks/:id

**功能**：软删除任务，并清理该任务的帧文件与导出产物。数据库记录保留 `deleted_at`，不物理删除，便于恢复与审计。

**Query**：`purge=1` 时同时物理删除 `data/frames/<task_id>/` 目录（默认只标记）。

**响应体 200**

```json
{ "code": 0, "message": "ok", "data": { "id": "rvs_t_01JCK9X2M4TZ3EBQXV", "deleted": true, "files_purged": false } }
```

**错误码**：`404 NOT_FOUND`、`409 CONFLICT`（任务正在 `extracting` / `analyzing`，需先 cancel）。

---

### 3.9 POST /api/v1/tasks/:id/pause

**功能**：暂停。正在执行的 analysis 允许跑完并落结果，队列中的条目挂起。

**请求体**：空对象 `{}`（可省略 body）。

**响应体 200**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "id": "rvs_t_01JCK9X2M4TZ3EBQXV",
    "status": "paused",
    "in_flight_analyses": 1,
    "queued_analyses": 7,
    "poll_interval_ms": 3000
  }
}
```

**错误码**：`404 NOT_FOUND`、`409 CONFLICT`（任务不在 `running` 状态）。

---

### 3.10 POST /api/v1/tasks/:id/resume

**功能**：恢复。从最早未完成的 analysis 继续，已完成的不重跑。

**响应体 200**

```json
{
  "code": 0, "message": "ok",
  "data": { "id": "rvs_t_01JCK9X2M4TZ3EBQXV", "status": "running", "queued_analyses": 7, "poll_interval_ms": 1000 }
}
```

**错误码**：`404 NOT_FOUND`、`409 CONFLICT`（任务不在 `paused` 状态）。

---

### 3.11 POST /api/v1/tasks/:id/cancel

**功能**：取消。中断 socket 与 ffmpeg 子进程；已完成的分析结果**保留**，仍可查询与导出。

**请求体**：`{ "reason": "user_request" }`（`reason` 可选）。

**响应体 200**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "id": "rvs_t_01JCK9X2M4TZ3EBQXV",
    "status": "cancelled",
    "completed_analyses": 8,
    "discarded_analyses": 4,
    "retained_result_count": 17
  }
}
```

**错误码**：`404 NOT_FOUND`、`409 CONFLICT`（任务已在 `done` / `cancelled` 终态）。

---

### 3.12 GET /api/v1/results

**功能**：跨任务的结果列表，支持去重开关、多维筛选与排序。这是前端主结果页的唯一数据源。

**Query**

| 参数 | 类型 | 说明 |
|---|---|---|
| `task_ids` | string | 逗号分隔；省略表示全部未删除任务 |
| `engine_ids` | string | 逗号分隔 |
| `domain` | string | 按结果域名精确过滤 |
| `q` | string | 在 `title` / `snippet` / `canonical_url` 中模糊匹配 |
| `score_source` | string | `engine_provided` / `local_normalized` / `none` |
| `min_score` | real | 0.0 - 1.0 |
| `min_hits` | integer | 最少证据数（跨帧去重后的 `hit_count` 下界） |
| `dedupe` | integer | `1`（默认）按 `canonical_url` 聚合；`0` 展平为逐条证据 |
| `sort` | string | `best_score`（默认） / `hit_count` / `engine_position` / `last_seen_at` |
| `order` | string | `asc` / `desc`，默认 `desc` |
| `page` / `limit` | integer | 分页 |

**响应体 200（dedupe=1）**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "items": [
      {
        "id": "rvs_r_01JCK9X2M4TZ3EBQYC",
        "canonical_url": "https://www.example-site.com/post/123",
        "domain": "www.example-site.com",
        "title": "示例文章标题",
        "snippet": "包含该画面的原始报道",
        "thumb_url": "https://www.example-site.com/thumb.jpg",
        "best_score": 0.95,
        "score_source": "local_normalized",
        "score_display": "0.95（由引擎返回位次归一）",
        "engine_rank_best": 1,
        "local_similarity": null,
        "hit_count": 4,
        "engine_count": 2,
        "frame_count": 3,
        "engines": ["google_lens", "yandex"],
        "first_seen_at": "2026-10-24T08:16:05.000Z",
        "last_seen_at": "2026-10-24T08:17:11.000Z"
      }
    ],
    "total": 24, "page": 1, "limit": 20, "hasMore": true,
    "facets": {
      "engines": { "google_lens": 24, "yandex": 18, "bing": 0 },
      "domains": { "www.example-site.com": 9, "news.other.com": 4 }
    }
  }
}
```

**响应体 200（dedupe=0）**：`items` 中每项增加 `analysis_id`、`task_id`、`frame_id`、`engine_id`、`engine_position`、`evidence_url`，其余字段相同。

**相似度口径约束（强制）**

- `score_source = engine_provided`：引擎自身返回了数值分数，原样展示。
- `score_source = local_normalized`：引擎只给了排序位次，由本地归一，`best_score = max(0, 1 - (engine_rank_best - 1) / 10)`。
- `score_source = none`：无可用分数信号，`best_score` 为 `null`，**UI 禁止显示任何数字或伪造的百分比**。
- `local_similarity`：本地 dHash 汉明距离换算的相似度，仅在候选缩略图可被本地取到哈希时才有值；不可得时为 `null`，不得用 0 代替。

**错误码**：无业务错误；非法参数回落默认值。

---

### 3.13 GET /api/v1/export.csv

**功能**：导出结果为 CSV（UTF-8，含 BOM 以便 Excel 正确识别中文）。单文件一次性返回，不做流式分页。

**Query**：与 `GET /api/v1/results` 完全相同，但**不支持** `page` / `limit`（导出全部命中）。

**响应**：`200 text/csv; charset=utf-8`，带 `Content-Disposition: attachment; filename="rvs-results-20261024-081700.csv"`。

**列清单与顺序**

```
canonical_url,domain,title,snippet,best_score,score_source,engine_rank_best,local_similarity,
hit_count,engine_count,frame_count,engines,first_seen_at,last_seen_at
```

其中 `engines` 以 `|` 分隔；`null` 一律输出为空字符串，不输出 `NULL` / `null` 字面量。

**错误码**：`404 NOT_FOUND`（筛选后为空集时仍返回 200，仅含表头——空集不是错误）。

---

### 3.14 GET /api/v1/export.json

**功能**：导出结果为 JSON，结构与 `GET /api/v1/results` 一致，附带导出元信息与配置快照，便于追溯"这批结果是怎么来的"。

**Query**：同 `export.csv`。

**响应体 200**

```json
{
  "schema_version": 1,
  "exported_at": "2026-10-24T08:17:00.000Z",
  "generator": { "name": "RVS", "version": "0.1.0", "node": "v22.22.2", "ffmpeg": "8.1.1" },
  "filters": { "task_ids": [], "engine_ids": [], "dedupe": 1, "sort": "best_score", "order": "desc" },
  "totals": { "results": 24, "hits": 61, "tasks": 1, "frames_analyzed": 4 },
  "results": [ { } ]
}
```

`totals.hits` 为去重前的证据条数（即 `result_hits` 行数），`totals.results` 为去重后的规范结果数。

---

### 3.15 GET /api/v1/engines/health

**功能**：返回三家引擎的启用状态、可用接入方式、熔断状态与最近探测结果。驱动结果页与设置页的引擎卡片。

**Query**：`probe=1` 时同步执行一次轻量连通性探测（每引擎最多放行 1 个请求，且全局 60 秒节流一次），省略则只读库不发起网络请求。

**响应体 200**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "proxy": { "configured": true, "address": "http://127.0.0.1:7897", "reachable": true, "checked_at": "2026-10-24T08:15:00.000Z" },
    "engines": [
      {
        "engine_id": "google_lens",
        "display_name": "Google Lens",
        "enabled": true,
        "modes": {
          "deeplink": { "supported": true, "verification": "verified", "requires_public_url": true, "default_on": true },
          "upload":   { "supported": true, "verification": "unverified", "requires_public_url": false, "default_on": false }
        },
        "circuit_state": "closed",
        "consecutive_failures": 0,
        "last_probe_at": "2026-10-24T08:15:02.000Z",
        "last_http_status": 200,
        "last_latency_ms": 3184,
        "last_error_code": null,
        "notes": "deeplink 形态已在本机验证返回 200；multipart 直传因环境限制未验证，默认关闭"
      },
      {
        "engine_id": "bing",
        "display_name": "Bing",
        "enabled": true,
        "modes": {
          "deeplink": { "supported": true, "verification": "partial", "requires_public_url": true, "default_on": true },
          "upload":   { "supported": true, "verification": "unverified", "requires_public_url": false, "default_on": false }
        },
        "circuit_state": "closed",
        "consecutive_failures": 2,
        "last_probe_at": "2026-10-24T08:14:58.000Z",
        "last_http_status": 200,
        "last_latency_ms": 5102,
        "last_error_code": null,
        "notes": "主机与 /images/search 路径已验证 200；imgurl 深链参数形态未在本机验证"
      }
    ],
    "imagehosts": [
      { "host_id": "catbox",    "enabled": false, "verification": "unverified", "note": "未在本环境验证，开启后帧内容会被公开" },
      { "host_id": "0x0",       "enabled": false, "verification": "unverified", "note": "同上" },
      { "host_id": "tmpfiles",  "enabled": false, "verification": "unverified", "note": "同上" }
    ]
  }
}
```

`verification` 取值严格限定为 `verified` / `partial` / `unverified` 三者之一，**前端必须据此渲染不同角标**，不得把 `partial` 与 `verified` 混为一谈。

---

### 3.16 GET /api/v1/settings

**功能**：读取当前设置默认值与取值来源（环境变量 vs 用户覆盖）。

**响应体 200**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "settings": {
      "net.proxy":            { "value": "http://127.0.0.1:7897", "type": "string",  "source": "env",     "editable": false },
      "net.total_timeout_ms": { "value": 45000,                   "type": "integer", "source": "default", "editable": true },
      "extract.mode":         { "value": "scene",                 "type": "string",  "source": "user",    "editable": true },
      "extract.max_frames":   { "value": 12,                      "type": "integer", "source": "default", "editable": true },
      "hash.hamming_threshold": { "value": 6,                     "type": "integer", "source": "default", "editable": true },
      "queue.analysis_parallelism": { "value": 2,                 "type": "integer", "source": "default", "editable": true },
      "engine.google_lens.enabled": { "value": true,              "type": "boolean", "source": "user",    "editable": true },
      "engine.google_lens.upload_mode": { "value": false,         "type": "boolean", "source": "default", "editable": true, "experimental": true },
      "imagehost.enabled":    { "value": false,                   "type": "boolean", "source": "default", "editable": true, "experimental": true },
      "retention_days":       { "value": 30,                      "type": "integer", "source": "default", "editable": true },
      "debug.retain_raw_html": { "value": false,                  "type": "boolean", "source": "default", "editable": true }
    },
    "experimentals": [
      { "key": "engine.google_lens.upload_mode", "label": "Google Lens 直传模式",
        "warning": "直传端点未在本环境完成验证，失败会自动降级到链接模式" },
      { "key": "imagehost.enabled", "label": "图床桥接",
        "warning": "启用后会把你视频中的一帧上传到第三方公开图床，任何拿到链接的人都能看到它" }
    ]
  }
}
```

---

### 3.17 PUT /api/v1/settings

**功能**：部分更新设置。标记为 `editable: false`（来源为 `env`）的键被包含在请求中时返回 `400`。

**请求体**

```json
{
  "extract.mode": "scene",
  "extract.max_frames": 20,
  "imagehost.enabled": true,
  "imagehost.provider": "catbox",
  "imagehost.consent_ack": true
}
```

**图床开启的强制校验**：把 `imagehost.enabled` 从 `false` 置为 `true` 时，必须同时提供 `imagehost.consent_ack = true`，否则返回 `400 BAD_REQUEST`，`message` 为"开启图床桥接需要显式确认：该帧会被上传到第三方公开图床"。

**响应体 200**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "updated": ["extract.mode", "extract.max_frames", "imagehost.enabled", "imagehost.provider", "imagehost.consent_ack"],
    "ignored": [],
    "requires_restart": []
  }
}
```

**错误码**：`400 BAD_REQUEST`（键不存在 / 类型不符 / `editable: false` / 缺 `consent_ack`）。

---

### 3.18 GET /api/v1/logs

**功能**：查询结构化运行日志，用于排障。**只返回本应用自身产生的日志**，不含第三方内容。

**Query**

| 参数 | 说明 |
|---|---|
| `level` | `debug` / `info` / `warn` / `error`，逗号分隔 |
| `category` | `net` / `media` / `engine` / `queue` / `api` / `db` |
| `request_id` | 精确匹配 |
| `task_id` | 精确匹配 |
| `q` | 消息子串匹配 |
| `since` / `until` | ISO 8601 时间窗 |
| `page` / `limit` | 分页，默认 `limit=100` |

**响应体 200**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "items": [
      {
        "ts": "2026-10-24T08:16:02.104Z",
        "level": "warn",
        "category": "engine",
        "request_id": "rvs_req_01JCK9X2M4TZ3EBQXZ",
        "task_id": "rvs_t_01JCK9X2M4TZ3EBQXV",
        "event": "analysis.degraded",
        "message": "upload rejected, falling back to deeplink",
        "fields": { "analysis_id": "rvs_a_01JCK9X2M4TZ3EBQYD", "engine_id": "bing", "http_status": 413, "error_code": "UPLOAD_REJECTED" }
      }
    ],
    "total": 1, "page": 1, "limit": 100, "hasMore": false
  }
}
```

日志同时以 JSONL 追加写入 `data/logs/rvs-YYYYMMDD.jsonl`，按 `retention_days` 清理。

---

## 4. 数据库设计

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

**为什么 `results` 是去重后的表**：同一个 URL 被 3 帧 × 2 引擎命中时，`results` 只有 1 行，`result_hits` 有 6 行。`result_hits` 是纯证据关系表，承载"谁在什么时候、以什么位次命中了它"。这样 `GET /api/v1/results` 的 `dedupe=1` 查询就在 `results` 上做，`dedupe=0` 就在 `result_hits` 上做，两条查询都不需要 `GROUP BY`。

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

这是 `GET /api/v1/results` 在 `dedupe=1` 时直接读取的表。一行代表一个"网络上的规范目标"，`canonical_url` 唯一。

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
| `tasks` | 一次用户提交 | 1 | `GET /api/v1/tasks`、`GET /api/v1/tasks/:id` |
| `frames` | 任务下的一帧 | 4 - 60 | `GET /api/v1/tasks/:id/frames` |
| `analyses` | 帧 × 引擎 | 帧数 × 引擎数（≤ 3） | `GET /api/v1/search/analyses/:id` |
| `results` | 去重后的规范目标 | 命中 URL 数 | `GET /api/v1/results`（`dedupe=1`） |
| `result_hits` | 一次分析的一条命中证据 | analyses 数 × 每次命中数 | `GET /api/v1/results`（`dedupe=0`）、facets |
| `engine_health` | 一个引擎一行 | 3 | `GET /api/v1/engines/health` |
| `settings` | 一个配置键一行 | 约 20 | `GET /api/v1/settings` |

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
