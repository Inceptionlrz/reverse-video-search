# ADR-004: 引擎适配器采用「两级接入 + 四级降级」契约

## Status

Accepted（2026-10-24）

## Background

产品需要接三家反向图搜引擎（Google Lens、Yandex、Bing），但本环境存在一个无法回避的限制：

> Node spawn 出的子进程发起的出站 HTTPS 会被中间设备替换为 696 字节桩响应（响应头 `server: Microsoft-IIS/10.0`），见证据 E-04。唯一能取到真实响应的通道是 PowerShell 的 `Invoke-WebRequest`。

通过 PowerShell 完成的实测只有三条：

| 端点 | 结果 | 证据 |
|---|---|---|
| `https://lens.google.com/uploadbyurl?url=<encoded>` | 200 | E-07 |
| `https://yandex.com/images/search?rpt=imageview&url=<encoded>` | 200 | E-08 |
| `https://www.bing.com/images/search?q=test` | 200，827593 字节 | E-09 |

**三家引擎的 multipart 直传端点、以及三个图床，全部没有取到真实响应**（E-12 ~ E-19，`未验证-环境限制`）。

此外还有一个结构性问题：本地服务监听 `127.0.0.1`，产出的帧对公网引擎不可达，而**所有 URL 型深链都要求图片 URL 公网可达**。

因此这里要决策的不是"用哪个端点"，而是：**在证据不完整的情况下，如何设计一个不会欺骗用户的接入契约。**

## Decision

### 一、每家引擎提供两级接入，并在数据模型中显式记录验证状态

| 级别 | 代号 | 形态 | 默认 |
|---|---|---|---|
| 一级 | `deeplink` | URL 深链，图片 URL 作为参数 | 开（仅限 `verified` / `partial`） |
| 二级 | `upload` | multipart 直传到引擎上传端点 | **关**，标记实验性 |

三家的具体形态与状态：

| 引擎 | deeplink | upload | deeplink 验证状态 |
|---|---|---|---|
| Google Lens | `GET https://lens.google.com/uploadbyurl?url=<encoded>` | `POST /v3/upload` multipart | `verified`（E-07） |
| Yandex | `GET https://yandex.com/images/search?rpt=imageview&url=<encoded>` | `POST /images/search` multipart `upfile` | `verified`（E-08） |
| Bing | `GET /images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:<encoded>` | `POST /images/api/v3/searchbyimage` 等 | `partial`（E-09 验证了主机与路径，参数形态未验证） |

**`verification` 字段只允许三个取值**：`verified` / `partial` / `unverified`，写入 `engine_health` 表并由 `GET /api/v1/engines/health` 暴露给前端。**前端必须据此渲染不同的角标**，不得把 `partial` 与 `verified` 混为一谈。

**禁止把 `unverified` 能力在产品文案中写成"支持"或"可用"。** 这是本项目级别的 P0 规则，不是建议。

### 二、补充能力：图床桥接（`bridge`），默认关闭

本地帧无公网 URL 时，`deeplink` 无法直接使用。为此提供可选桥接：先把帧上传到第三方图床换取公网 URL，再走 `deeplink`。

| 图床 | 验证状态 | 默认 |
|---|---|---|
| `catbox.moe` | `unverified`（E-17） | 关 |
| `0x0.st` | `unverified`（E-18） | 关 |
| `tmpfiles.org` | `unverified`（E-19） | 关 |

强制规则：

1. 必须由用户在设置页**显式开启**，UI 写明"这会把你视频中的一帧上传到第三方公开图床，任何拿到链接的人都能看到它"。
2. PUT 设置时把 `imagehost.enabled` 置真，必须同时提交 `imagehost.consent_ack = true`，否则返回 400。
3. 上传前把帧缩到长边 ≤ 640 并重编码。
4. 中转产生的 URL 写入 `analyses.imagehost_url`，结果中标注"该帧曾经由第三方图床中转"。

### 三、四级降级链路：每级必须写清失败原因，终点是"用户还能完成这件事"

```
[1] upload          仅当 engine.<id>.upload_mode = on
      ├─ 成功有命中   → succeeded
      ├─ 成功零命中   → zero_result（不是错误，终点）
      └─ 失败         → 记入 degradation_log，下一级
[2] deeplink        需要公网 URL：任务自带 URL > bridge 产出 URL
      ├─ 无可用 URL  → skipped_reason='no_public_url'，下一级
      ├─ 成功有命中   → succeeded
      ├─ 成功零命中   → zero_result（终点）
      └─ 失败         → 记入 degradation_log，下一级
[3] bridge + 重跑 [2]
      ├─ 图床未启用   → skipped_reason='imagehost_disabled'，下一级
      ├─ 图床上传失败 → UPLOAD_REJECTED，下一级
      └─ 上传成功 → 用该 URL 重跑一次 deeplink，结果同上分流
[4] manual          永不抛错
      把帧落到 data/frames/<task>/<seq>_<pts_ms>.jpg
      给出引擎上传页入口 URL（该 URL 不需要图片参数，只打开页面）
      analyses.status = 'manual'
      响应含 frame_file_path + open_page_url + instruction
```

要点：

- 每一级的结果（含"跳过"的原因）都要 `push` 进 `analyses.degradation_log`，UI 可展开。
- `manual` 不是失败态，是**待用户动作态**，UI 用琥珀色提示条而非红色错误。
- 三个引擎各自独立走自己的链路，互不牵连。
- 四级走完仍未命中时，`analyses.error_code` 取**最后一级真实错误**，不得为空。

### 四、错误分类与 `ZERO_RESULT` 的特殊地位

`RATE_LIMITED` / `FORBIDDEN` / `CAPTCHA` / `NETWORK_ERROR` / `TIMEOUT` / `PARSE_ERROR` / `ZERO_RESULT` / `PROVIDER_DISABLED` / `UPLOAD_REJECTED` 共九类。

**`ZERO_RESULT` 是 HTTP 200 + 正常流程终止，不是错误。** 它不触发重试、不触发熔断、不进 `consecutive_failures` 计数、UI 不显示红色。混淆它会让健康探针看起来一直在失败。

熔断规则：某引擎连续失败 5 次（不含 `ZERO_RESULT`）→ 熔断 120 秒 → 半开放 1 个探针。

### 五、相似度不得伪精确

三家引擎都不返回真实相似度数值。因此 `score_source` 强制三选一：

- `engine_provided`：引擎确实给了数值，原样展示。
- `local_normalized`：引擎只给了排序位次，本地归一 `best_score = max(0, 1 - (rank - 1) / 10)`，UI 必须标注"由引擎返回位次归一"。
- `none`：`best_score` 为 `null`，UI **禁止显示任何数字**。

`local_similarity` 与 `engine_score` 可以并列展示，但不得混合算成单一的"综合置信度"。

### 六、适配器接口契约

`server/providers/base.mjs` 定义统一形态，三家各自实现：

```
describe()      → { engine_id, display_name, modes: { deeplink: {...}, upload: {...} } }
run(ctx)        → ctx 含 { frame, options, cancelToken, log }
                  返回值：{ hits: [...], result_url, parse_strategy, http_status }
                  抛出的异常必须携带 §四 中的某个 error_code
```

`analysis.service.mjs` 是**唯一持有降级编排逻辑**的地方；provider 内部不得自行降级，也不得直接写库或调用 service。

## Consequences

正面：

- 无论外部端点是否可用，用户总有一条能走通的路径（`manual` 永远可用）。
- 证据状态进入数据模型而非散落在注释里，UI 可以直接消费，不会做出超出证据的承诺。
- 未验证的多级 upload 一旦在某个环境被确认可用，只需把 `engine_health.upload_verification` 从 `unverified` 改为 `verified`，并把 `upload_mode_default_on` 置 1，不需要改代码结构。

负面：

- 本地视频 + 未开图床 + 三家 upload 未验证的组合下，实际默认路径大概率走到 `manual`。这是**当前证据水平下的诚实结果**，不应为了"看起来能用"而放宽标记。
- 三级链路意味着每个 analysis 的 `degradation_log` 可能有 3 条记录，排障信息量增加，但这是必要的可观测成本。
- 图床桥接引入了数据外泄面，必须靠 UI 的显式同意与日志追溯来约束。

## Follow-up

| 待办 | 有效期 | 动作 |
|---|---|---|
| E-12 ~ E-16 三家 upload 端点验证 | 阻塞 `upload` 转正 | 用 PowerShell 逐个请求并记录状态码，回填 `scripts/probe/out-*` |
| E-10 Bing `q=imgurl:` 深链参数形态 | 阻塞 Bing 从 `partial` 升为 `verified` | 用 PowerShell 请求并记录响应体前 2 KB |
| E-17 ~ E-19 三个图床验证 | 阻塞 `bridge` 转正 | 同上 |

在以上回填完成前，`upload` 与 `bridge` 的默认值保持关闭。

## Related ADRs

- ADR-001：本决策依赖隧道作为出站通道
- ADR-002：适配器实现必须零依赖，multipart 由自研模块构造
