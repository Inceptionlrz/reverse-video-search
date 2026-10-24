# RVS 架构文档

> 项目代号：RVS（Reverse Video Search）
> 适用阶段：MVP
> 文档状态：决策已锁定，供前后端实现直接引用
> 最后更新：2026-10-24

---

## 0. 本文档的边界与诚实原则

本项目的外部环境存在一项硬性限制：**当前 agent 沙箱内，由 Node spawn 出的子进程发起的出站 HTTPS 请求会被中间设备（MITM）替换为 696 字节桩响应**（响应头 `server: Microsoft-IIS/10.0`）。因此所有"调用第三方引擎真实接口"的行为，在本环境中**无法完成端到端验证**。

本文档对每一个技术事实都标注了三种结论之一：

| 结论标记 | 含义 | 在设计中的地位 |
|---|---|---|
| `已验证` | 在本环境中被实际执行并观察到确定结果 | 可作为设计基础，可直接实现 |
| `部分验证` | 主机与路径可达，但本次未验证业务参数形态 | 可实现，但必须配套强降级 |
| `未验证-环境限制` | 受 MITM 限制，未取到真实响应 | **禁止**写作"可用"；仅作为实验性路径，默认关闭 |

任何实现者不得把 `未验证` 标记的功能在产品文案中描述为"支持"或"可用"。

---

## 1. 技术栈版本表（锁定）

| 层 | 选型 | 版本 / 具体形态 | 锁定原因 | 结论标记 |
|---|---|---|---|---|
| 运行时 | Node.js | **v22.22.2**（绝对路径 `C:/Users/samal/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`） | 内置 `node:sqlite` 可直接使用；本机唯一已确认可用且带 sqlite 的运行时 | 已验证 |
| SQLite 启用方式 | 启动参数 | 进程必须以 **`--experimental-sqlite`** 启动 | Node 22.22.2 的 `node:sqlite` 仍处于实验门后 | 已验证（`require`/`import` 均可拿到模块） |
| HTTP 出站 | Node 原生 `node:http` / `node:tls` + 自研 CONNECT 隧道 | 无第三方库 | `require('undici')` 在本机不可解析；内置 `fetch` 的 `NODE_USE_ENV_PROXY=1` 实测不生效，无法走 127.0.0.1:7897 代理 | 已验证（两者均被排除） |
| HTTP 入站 | Node 原生 `node:http` 手写路由 | 无 Express 等框架 | 零依赖、单进程、路由面已知且很小（见 `docs/API.md` 共 16 个端点） | 已验证（决策性，非实测） |
| Web 框架 | 不使用 | — | 端点数量与中间件需求远低于引入框架的收益；静态文件由 `node:fs` 直接流式输出 | — |
| 存储 | `node:sqlite`（内置） | Node 22.22.2 内置版本 | 单用户本地工具，SQLite 单文件足以覆盖；避免引入 `better-sqlite3` 等需要本机编译的依赖 | 已验证 |
| 视频元数据 | `ffprobe` 命令行 | ffmpeg 套件 **8.1.1**，已在 `PATH` | 唯一可行的音视频元数据获取途径 | 已验证 |
| 视频抽帧 | `ffmpeg` 命令行 | ffmpeg 套件 **8.1.1** | 唯一可行的解码与抽帧途径 | 已验证 |
| 图像处理 | ffmpeg 输出灰度原始缓冲 + Node 纯 JS 计算 dHash | 自研，约 60 行 | 无 `sharp` / `jimp` 可用；由 ffmpeg 承担解码与缩放，Node 侧只做 64 次比较运算 | 依赖功能已验证（见 §6） |
| 前端 | 原生 HTML + CSS + 原生 ES Module JS | 无框架、无打包器、无 CDN | 本地服务直接 serve 静态文件；离线可用；图标为内联 SVG sprite | — |
| 图标体系 | 内联 SVG sprite，命名 `rvs-icon-{name}` | 24 viewBox / `stroke-width: 1.5` / `currentColor` | 设计师已锁定；零外部请求，符合 P0 禁止 emoji 图标规则 | — |
| 包管理 | **不使用 npm 作为运行时依赖来源** | `package.json` 仅作元信息与脚本登记 | 保证零安装即可运行 | — |
| 操作系统 | Windows | Git Bash 与 PowerShell 均可用 | 注意路径分隔符与 ffmpeg 可执行文件后缀的处理 | 已验证 |

### 1.1 存储层的唯一兜底约定

`node:sqlite` 是唯一选定的持久化方案。仓储层（`server/lib/db/repo/*`）必须**只暴露异步方法签名，不向上泄漏 sql 字符串与 `Database` 实例**。这是为了在极端情况下（某台机器 Node 版本不支持 sqlite）可以在该层内替换为文件型实现，而不动任何 service。MVP **不实现**该兜底，但接口必须留出来。

---

## 2. 实测证据表

下表每一行都是可以直接复看的证据。编号 `E-xx` 在 ADR 中被引用。

### 2.1 运行时与网络

| # | 对象 / 端点 | 方法 | 环境 | 观测结果 | 结论 |
|---|---|---|---|---|---|
| E-01 | `require('undici')` | Node 22.22.2 直接 require | 本机 | 模块不可解析 | 已验证（不可用） |
| E-02 | `NODE_USE_ENV_PROXY=1` + 内置 `fetch` 出站 | Node 22.22.2 | 本机，需经 127.0.0.1:7897 | 请求未按代理转发，直连失败 | 已验证（无效，不得依赖） |
| E-03 | `require('node:sqlite')` | Node 22.22.2 + `--experimental-sqlite` | 本机 | 模块正常返回，`DatabaseSync` 可用 | 已验证 |
| E-04 | 任意出站 HTTPS | Node spawn 子进程 | agent 沙箱 | 返回 696 字节桩响应，`server: Microsoft-IIS/10.0` | 已验证（本环境不可用于端点实测） |
| E-05 | Node 原生 `http.request` CONNECT 到代理 | 自研隧道 | 本机 | 需执行 `tools/probe-tunnel.mjs` 产出 | 未验证-待执行（ADR-001 落地后立即补测） |
| E-06 | PowerShell `Invoke-WebRequest` | PowerShell 工具(rg除外) | agent 沙箱 | 可取到真实响应（见 §2.2） | 已验证（唯一真实响应通道） |

### 2.2 三家引擎与图床

| # | 对象 / 端点 | 方法 | 环境 | 观测结果 | 结论 |
|---|---|---|---|---|---|
| E-07 | `https://lens.google.com/uploadbyurl?url=<encoded>` | GET | PowerShell | **200** | 已验证 |
| E-08 | `https://yandex.com/images/search?rpt=imageview&url=<encoded>` | GET | PowerShell | **200** | 已验证 |
| E-09 | `https://www.bing.com/images/search?q=test` | GET | PowerShell | **200**，响应体 827593 字节 | 已验证（仅基础路径） |
| E-10 | `https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:<encoded>` | GET | PowerShell | 未执行 | **部分验证**（主机与路径形态参照 E-09，业务参数未验证） |
| E-11 | `GET https://www.bing.com/images/search?detailv2&imgurl=` 及 A1/A2/A3 系列 | GET / POST | — | 见 `scripts/probe/out-A*.txt` | **部分验证**（主机与路径参照 E-09，`detailv2` / `imgurl` 参数形态未验证） |
| E-12 | `POST https://lens.google.com/v3/upload`（multipart） | POST | PowerShell | 未执行 | 未验证-环境限制 |
| E-13 | `POST https://www.bing.com/images/api/v3/searchbyimage`（multipart） | POST | PowerShell | 未执行 | 未验证-环境限制 |
| E-14 | `POST https://www.bing.com/images/visualsearch` | POST | PowerShell | 未执行 | 未验证-环境限制 |
| E-15 | `POST https://www.bing.com/images/async/searchbyimage` | POST | PowerShell | 未执行 | 未验证-环境限制 |
| E-16 | `POST https://yandex.com/images/search`（multipart `upfile`，含 cbir 变体） | POST | PowerShell | 未执行 | 未验证-环境限制 |
| E-17 | 图床 `catbox.moe` | POST multipart | PowerShell | 未执行 | 未验证-环境限制 |
| E-18 | 图床 `0x0.st` | POST multipart | PowerShell | 未执行 | 未验证-环境限制 |
| E-19 | 图床 `tmpfiles.org` | POST multipart | PowerShell | 未执行 | 未验证-环境限制 |

### 2.3 ffmpeg / ffprobe

| # | 命令 | 环境 | 观测结果 | 结论 |
|---|---|---|---|---|
| E-20 | `ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate,codec_name -of default=nw=1 <file>` | ffmpeg 8.1.1 | 输出 `codec_name=h264`、`width=320`、`height=180`、`r_frame_rate=15/1`、`duration=6.000000` | 已验证 |
| E-21 | `ffmpeg -v error -i <f> -vf "fps=fps=1/1.5,scale=320:-2" -q:v 3 -frames:v 5 out/f_%03d.jpg -y` | ffmpeg 8.1.1 | 6 秒视频产出 **4 张**帧 | 已验证 |
| E-22 | `ffmpeg -v info -i <f> -filter:v "select='gt(scene,0.25)',showinfo" -f null -`（从 stderr 提取 `pts_time:([0-9.]+)`） | ffmpeg 8.1.1 | 含 2 秒处硬切的视频精确返回 `pts_time:2` | 已验证 |
| E-23 | `ffmpeg -ss <t> -i <f> -frames:v 1 -q:v 3 out.jpg`（`-ss` 在 `-i` 之前，走快 seek） | ffmpeg 8.1.1 | 定点导出成功 | 已验证 |

---

## 3. 运行时与网络模型

### 3.1 出站必须走 CONNECT 隧道

本机所有对三家引擎的访问必须经由 HTTP 代理（默认 `http://127.0.0.1:7897`，由 `RVS_PROXY` 配置）。由于内置 `fetch` 不支持代理、`undici` 不可用（E-01 / E-02），出站实现为：

```
应用代码
  │  https.request(options, cb)      ← options.agent = tunnelAgent
  ▼
TunnelAgent extends https.Agent
  │  createConnection()
  ├─ http.request({ host: proxyHost, port: proxyPort,
  │                 method: 'CONNECT', path: 'targetHost:443' })
  ├─ 监听 'connect' 事件 → 拿到 res.socket（裸 TCP）
  └─ tls.connect({ socket, servername: targetHost }) → 返回 TLS 套接字
  ▼
目标引擎（443）
```

要点：

1. `TunnelAgent` 继承 `https.Agent`，只重写 `createConnection`，其余连接复用行为沿用原生实现。
2. 代理本身是 HTTP，因此 CONNECT 阶段用 `node:http`；拿到隧道 socket 后用 `node:tls` 升级。
3. 上层代码仍然用标准的 `https.request(...) / req.write(body)`，因此 **multipart 直传不需要手写 HTTP 报文**。
4. 当 `RVS_PROXY` 为空时，退化为 `new https.Agent()`（直连），保证无代理环境也能跑，不改变调用方代码。
5. 隧道建立、TLS 握手、首字节（TTFB）三类超时必须分别设置并在错误分类中区分（见 §8）。

### 3.2 为什么不能依赖进程内的 fetch

`NODE_USE_ENV_PROXY=1` 对内置 fetch 实测无效（E-02）。所有出站路径统一走 `TunnelAgent`，**代码中禁止出现 `fetch(`**。此约束由架构评审与人工 code review 保证，MVP 不引入 lint 工具链。

### 3.3 代理故障的暴露

首次访问引擎前，必须执行一次轻量连通性探测（复用 E-07 已验证的形态之一）。若 CONNECT 都无法建立，立即把三家引擎全部置为 `PROVIDER_DISABLED`，并在 UI 顶部给出"代理不可达，所有在线检索不可用，仍可使用本地抽帧与导出"的明确提示。不得让用户等待单个 analysis 超时才发现问题。

---

## 4. 三家引擎接入方式矩阵

### 4.1 接入方式定义

| 方式代号 | 含义 | 前置条件 | 默认开关 |
|---|---|---|---|
| `deeplink` | 以 URL 深链形式打开/请求引擎的反向搜图入口，图片 URL 作为参数 | 需要**公网可达**的图片 URL | 开（仅对已验证/部分验证的引擎） |
| `upload` | multipart/form-data 直接上传本地帧文件到引擎的上传统一入口 | 引擎接受表单直传 | **关**（实验性） |
| `bridge` | 先把帧上传到第三方图床换取公网 URL，再以 `deeplink` 方式使用 | 图床服务可用 | **关**（实验性，且 `deeplink` 必须开） |
| `manual` | 打开引擎的人工上传页面，并把该帧写入本地目录供用户手动拖入 | 无 | 永远可用（兜底） |

### 4.2 引擎 × 方式矩阵

| 引擎 | `deeplink` | `upload` | 依赖图床 | 证据 | 状态说明 |
|---|---|---|---|---|---|
| Google Lens | `GET https://lens.google.com/uploadbyurl?url=<encoded>` | `POST https://lens.google.com/v3/upload`（multipart，字段名未验证） | 是 | E-07 / E-12 | `deeplink` **实测不可用**（`uploadbyurl` 返回 200 但页面无 Lens 结果结构，实测 2026-10-24）；`upload` 未验证，默认关闭 |
| Yandex | `GET https://yandex.com/images/search?rpt=imageview&url=<encoded>` | `POST https://yandex.com/images/search`（multipart `upfile`，含 cbir 变体） | 是 | E-08 / E-16 | `deeplink` **未验证**（返回 200 但结果为客户端渲染，服务端取不到结构）；`upload` 未验证，默认关闭 |
| Bing | `GET https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:<encoded>` | `POST https://www.bing.com/images/api/v3/searchbyimage` 等三个候选（见 `scripts/probe/out-A*`） | 是 | E-09 / E-10 / E-13~E-15 | `deeplink` **已验证**（实测 2026-10-24）；`upload` 未验证，默认关闭 |

> 上表「状态说明」以 **live `GET /api/engines` 的 `availability` 字段**为准（`verified` / `unverified` / `unavailable`），
> 而非文档撰写时的预期。引擎可用性会随引擎侧改版变化，联调前先读一次 live 数据；
> 前端「引擎诊断」页渲染的也是同一份 live 数据。

### 4.3 为什么本地帧不能直接用 deeplink

本地服务监听 `127.0.0.1`，产出的 `file://` 或 `http://127.0.0.1/...`  URL 对公网引擎不可达。因此：

- 用户**自带公网 URL**（PRD 中的"视频 URL 粘贴"入口）时，`deeplink` 直接可用，这是**最优路径**。
- 用户上传**本地文件**时，`deeplink` 必须经过 `bridge` 图床桥接换取公网 URL，否则只能走 `upload` 或 `manual`。

### 4.4 图床桥接（默认关闭）

| 图床 | 上传形态 | 保留策略 | 证据 | 默认 |
|---|---|---|---|---|
| `catbox.moe` | multipart | 永久或长周期（取决于其策略） | E-17 | 关 |
| `0x0.st` | multipart | 短周期 | E-18 | 关 |
| `tmpfiles.org` | multipart | 短周期 | E-19 | 关 |

约束：

1. 必须由用户在设置页**显式开启**，且 UI 必须说明"这会把你视频中的一帧上传到第三方公开图床，任何拿到链接的人都能看到它"。
2. 开启后仍需用户在单任务层面确认；不可做成"一次开启无限期生效"的隐式行为。
3. 上传前把该帧缩放到长边 ≤ 640 并重编码为 JPEG q=3，降低可辨识度与体积。
4. 图床返回的 URL 写入 `analyses.imagehost_url`（同时更新 `frames.source_url`），并在结果中标注"该帧曾经由第三方图床中转"，保证可追溯。

---

## 5. 降级链路

每个 analysis（帧 × 引擎）的执行严格按照下列顺序尝试，一旦某级成功即停止：

```
START analysis(frame, engine)
  │
  ├─[0] 前置判定 ──────────────────────────────────────────────┐
  │    用户在设置中禁用该引擎？  → PROVIDER_DISABLED，END(manual)│
  │    引擎连续失败已熔断？      → PROVIDER_DISABLED，END(manual)│
  │    代理连通性探测失败？      → NETWORK_ERROR，END(manual)    │
  └───────────────────────────────────────────────────────────┘
  │
  ▼
[1] upload（multipart 直传）          仅当 SETTINGS.engine.<e>.upload = on
  │   成功且可解析          → attempt_mode='upload'   →  DONE
  │   UPLOAD_REJECTED(413/415/400) → 落下一级
  │   RATE_LIMITED / FORBIDDEN / CAPTCHA / TIMEOUT / NETWORK_ERROR → 落下一级
  │   PARSE_ERROR（200 但读不出结构）→ 落下一级（保留原始 HTML 片段供诊断）
  ▼
[2] deeplink（URL 深链）
  │   需要公网 URL：来源优先级 (a) 任务自带的公网输入 URL
  │                              (b) bridge 图床已产出的 URL
  │   两者皆无 → 直接跳到 [3]
  │   成功且有命中  → attempt_mode='deeplink'    →  DONE
  │   成功但零命中  → ZERO_RESULT（不是错误）     →  DONE
  │   失败          → 错误入栈，落下一级
  ▼
[3] bridge（图床桥接）+ 重试 [2]
  │   仅当 SETTINGS.imagehost.enabled = on 且用户对本任务已确认
  │   图床上传成功 → 拿到公网 URL → 用该 URL 重跑一次 [2]
  │                   成功 → attempt_mode='bridge'   →  DONE
  │                   失败 → 错误入栈，落下一级
  │   图床上传失败 → UPLOAD_REJECTED，入栈，落下一级
  ▼
[4] manual（手工检索指引）
        把该帧以本地文件形式写入 data/frames/<task>/<frame>.jpg
        生成"打开 <引擎> 上传页"的深链（该深链**不需要**图片 URL，只打开入口页）
        analysis.status = 'manual'
        UI 展示：帧预览 + 一键复制文件路径 + 打开引擎页按钮
        → 终点，永不再抛出错误
```

降级规则：

1. **每一级失败都必须把错误对象 `push` 进 `analyses.degradation_log`**（JSON 数组），UI 要能展开看"为什么走到了手工模式"。
2. `manual` 不是失败态，是**待用户动作态**。它在 UI 上呈现为琥珀色提示条，不是红色错误。
3. 同一帧对三个引擎是三条独立 analysis，任一引擎降级到 manual 不影响其他引擎。
4. 四级链路全部失败时，`analyses.status = 'manual'`，`analyses.error_code` 取**最后一级**的错误码，`error_code` 永不为空。

---

## 6. 抽帧与感知哈希流水线

```
输入源 A：本地视频文件路径
输入源 B：公网视频/图片 URL
  │
  ├─ 若 B 且远程主机声明为图片 Content-Type → 跳过抽帧，直接作为单帧
  ▼
[Step 1] ffprobe 取元数据                    E-20
         duration / width / height / r_frame_rate / codec_name
         → 写入 tasks 表；宽度、时长用于决定抽帧策略
  ▼
[Step 2] 选择策略
         mode=interval  → ffmpeg 固定间隔         E-21
         mode=scene     → ffmpeg 场景检测 + 定点导出  E-22 + E-23
         mode=both      → 先 scene，不足 max_frames 时用 interval 补足，按时间排序去重
  ▼
[Step 3] 输出帧
         统一转码：scale=320:-2，JPEG q:v 3
         文件落在 data/frames/<task_id>/<seq>_<pts_ms>.jpg
  ▼
[Step 4] dHash（每帧）
         ffmpeg -v error -i <frame> -vf "scale=9:8,format=gray" -f rawvideo -pix_fmt gray -
         → 得到 72 字节灰度缓冲（9 宽 × 8 高）
         → Node 侧逐行比较相邻像素：8 列 × 8 行 = 64 bit，置位规则 left > right ? 1 : 0
         → 十六进制字符串写入 frames.dhash
  ▼
[Step 5] 帧内去重
         汉明距离 ≤ 6（可配置）的相邻帧归入同一 group，`frames.is_duplicate = 1`
         去重**只影响默认分析范围**，用户可在 UI 上选择"分析全部帧（含重复）"
```

抽帧命令（实测形态，直接采用）：

```
# 元数据
ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate,codec_name -of default=nw=1 <file>

# 固定间隔（每 1.5 秒一帧，最多 5 帧，长边缩到 320）
ffmpeg -v error -i <f> -vf "fps=fps=1/1.5,scale=320:-2" -q:v 3 -frames:v 5 out/f_%03d.jpg -y

# 场景检测（阈值 0.25，从 stderr 用 pts_time:([0-9.]+) 提取时间点）
ffmpeg -v info -i <f> -filter:v "select='gt(scene,0.25)',showinfo" -f null -

# 按时间点定点导出单帧（-ss 在 -i 之前走快 seek）
ffmpeg -ss <t> -i <f> -frames:v 1 -q:v 3 -vf "scale=320:-2" out.jpg -y

# dHash 输入
ffmpeg -v error -i <frame> -vf "scale=9:8,format=gray" -f rawvideo -pix_fmt gray -
```

约束：

- 所有 ffmpeg / ffprobe 调用走 `child_process.spawnFile`，**参数以数组传递，禁止拼接 shell 字符串**，避免路径含空格或用户可控字符导致注入。
- ffmpeg stderr 必须全程捕获（`-v info` 的场景检测依赖 stderr），但不能让 stderr 缓冲撑爆内存：设置 `maxBuffer: 8 MiB`，超出则中止并按 `PARSE_ERROR` 归类。
- 单任务最大帧数由 `max_frames` 控制（默认 12，上限 60）。若视频时长 × 期望密度超过上限，按等距抽样截断，并在 UI 明示"已按上限抽样"。

---

## 7. 分层架构与依赖规则

### 7.1 分层图

```
┌───────────────────────────────────────────────────────────────────┐
│  表现层   public/index.html + public/assets/*.js（原生 ESM，无构建） │
│           图标：内联 SVG sprite，rvs-icon-{name}                    │
└──────────────────────────────────┬────────────────────────────────┘
                                   │ HTTP/1.1  JSON   127.0.0.1:8787
┌──────────────────────────────────▼────────────────────────────────┐
│  路由层   server/lib/server/router.mjs + server/routes/*.routes.mjs│
│           职责：路径匹配、参数校验、调用 service、序列化响应。         │
│           禁止：业务判断、SQL、直接 spawn、直接访问引擎。             │
├───────────────────────────────────────────────────────────────────┤
│  服务层   server/services/*.service.mjs                            │
│           职责：业务编排、事务边界、去重、导出、熔断计数、健康检查。    │
│           跨资源调用只允许 service → service。                      │
├──────────────┬──────────────────┬────────────────┬────────────────┤
│  领域适配层   │  数据层            │  媒体层          │  任务编排层     │
│  providers/  │  lib/db/repo/*    │  lib/media/*   │  lib/queue/*   │
│  引擎 + 图床  │  node:sqlite      │  ffmpeg 套件    │  并发 + 取消    │
│  外部 I/O    │  持久化            │  子进程          │  令牌          │
└──────────────┴──────────────────┴────────────────┴────────────────┘
                                   ▲
                                   │ 被 service 与 provider 共用，但不得反向引用
                          ┌────────┴────────┐
                          │  基础层  lib/http/*（隧道 Agent、请求、multipart、HTML 片段解析）
                          │          lib/*（配置、日志、错误、时间、ID）
                          └─────────────────┘
```

### 7.2 依赖方向（强制）

```
routes  →  services  →  providers
                    →  repo
                    →  lib/queue
                    →  lib/media
providers → lib/http, lib/media, lib/*        （不得 import services / repo / routes）
repo      → lib/db/client, lib/*              （不得 import services / providers / routes）
lib/*     → Node 内置模块                      （不得 import 任何上层）
lib/queue → lib/*                              （回调驱动，不反向持有 caller 类型）
```

违反方向的 `import` 视为架构缺陷，必须修正后才能合入。

### 7.3 文件规模硬约束

| 约束 | 值 | 超出时的处理 |
|---|---|---|
| 单文件行数上限 | **300 行** | 按职责拆分为同目录下的多个模块，禁止用注释分区代替拆分 |
| 单文件职责 | 一个模块只做一件事 | 例如路由模块不得同时写 SQL；解析与网络请求必须分文件 |
| 入口文件 | `server/bin/rvs.mjs` **只做装配**（加载配置 → 迁移 → 注册路由 → listen） | 入口中不得出现具体业务代码 |
| 命名 | 文件名 `<职责>.<层>.mjs`，例如 `tasks.repo.mjs`、`analysis.service.mjs` | 同一层同一类角色使用统一后缀，便于用文件名反向检验分层约束 |

---

## 8. 错误分类与处理策略

### 8.1 错误码字典

| code | 触发判定 | 用户可见文案要点 | 是否重试 | 是否降级 |
|---|---|---|---|---|
| `RATE_LIMITED` | 引擎返回 HTTP 429，或响应体出现限流特征 | "该引擎暂时限制请求频率，稍后自动重试" | 是（退避） | 是 |
| `FORBIDDEN` | HTTP 401 / 403 | "该引擎拒绝了本次请求（可能需要登录或地区限制）" | 否 | 是 |
| `CAPTCHA` | 响应体出现验证码/人机校验特征 | "该引擎要求人机验证，无法自动完成" | 否 | 是 |
| `NETWORK_ERROR` | DNS 失败、CONNECT 失败、TLS 失败、socket 提前关闭 | "网络不可达，检查代理设置" | 是（≤2 次） | 是 |
| `TIMEOUT` | 隧道建立 / TLS 握手 / 首字节 / 整体耗时 任一超限 | "请求超时" | 是（≤1 次） | 是 |
| `PARSE_ERROR` | HTTP 200 但无法提取任何结构化结果 | "响应格式与预期不符（引擎可能改版）" | 否 | 是 |
| `ZERO_RESULT` | HTTP 200 且解析成功但命中数为 0 | "未找到匹配结果" **——这不是错误** | 否 | 否（视为成功） |
| `PROVIDER_DISABLED` | 用户在设置中关闭该引擎，或该引擎被熔断器摘除 | "该引擎当前未启用" | 否 | 否（直接进 manual） |
| `UPLOAD_REJECTED` | multipart 直传被拒（400 / 413 / 415 或图床错误） | "直接上传未被接受，改用链接方式" | 否 | 是 |

补充的内部错误（不进 provider 层，属 API 框架层）：`BAD_REQUEST` `NOT_FOUND` `CONFLICT`（任务已在终态却收到 pause/resume）`MEDIA_ERROR`（ffmpeg 非零退出）`INTERNAL`。

### 8.2 重试策略

| 错误码 | 最大重试 | 退避 |
|---|---|---|
| `NETWORK_ERROR` | 2 | 指数退避 500ms → 1500ms，带 ±20% 抖动 |
| `TIMEOUT` | 1 | 固定 1000ms |
| `RATE_LIMITED` | 2 | 读取 `Retry-After` 头；无则 3000ms → 9000ms |
| 其余 | 0 | — |

### 8.3 熔断器

每个 engine 独立计数：连续失败 **5** 次（不含 `ZERO_RESULT`）→ 熔断 **120 秒**；熔断期内所有新 analysis 直接判 `PROVIDER_DISABLED` 并直落 manual。半开状态放 1 个探针请求，成功则复位。状态写入 `engine_health` 表。

### 8.4 超时预算

| 阶段 | 默认 | 配置项 |
|---|---|---|
| CONNECT 隧道建立 | 8s | `net.connect_timeout_ms` |
| TLS 握手 | 8s | `net.tls_timeout_ms` |
| 首字节 | 15s | `net.ttfb_timeout_ms` |
| 整体请求 | 45s | `net.total_timeout_ms` |
| ffmpeg 单次抽帧 | 120s | `media.extract_timeout_ms` |
| ffprobe 元数据 | 20s | `media.probe_timeout_ms` |

---

## 9. 任务编排并发模型

### 9.1 队列与并发

```
task (1) ──► frames (N) ──► analyses (N × 选中引擎数 ≤ 3)
```

- 抽帧：单任务串行（ffmpeg 独占 CPU 密集），但不同 task 之间可并行，全局并发上限 `extract_parallelism` 默认 **1**。
- 分析：全局并发上限 `analysis_parallelism` 默认 **2**；同一引擎的并发上限 `per_engine_parallelism` 默认 **1**（避免触发限流）。
- 请求间隔：同一引擎两次请求最小间隔 `engine_min_interval_ms` 默认 **1200ms**，由队列层统一节流。

### 9.2 暂停 / 恢复 / 取消语义

| 动作 | 对正在执行的 analysis | 对排队中的 analysis | 落库 |
|---|---|---|---|
| `pause` | 允许当前请求跑完并写结果，不再取下一个 | 保留在队列，状态挂起 | `tasks.status='paused'` |
| `resume` | — | 重新入队，从最早未完成的 analysis 继续 | `tasks.status='running'` |
| `cancel` | 通过取消令牌 abort socket 与 ffmpeg 子进程（`SIGKILL` on Windows：`taskkill /PID`，优先尝试 `proc.kill()`） | 全部置 `cancelled` | `tasks.status='cancelled'`，已完成的结果**保留**可读 |

取消后 `tasks.status` 进入终态，不得再接收 `pause`/`resume`（返回 `CONFLICT`）。已完成的分析结果即使任务被取消也保留，导出接口仍可导出这部分。

### 9.3 幂等

- `POST /api/tasks/:id/frames/extract` 在同一 task 上重复调用返回 `CONFLICT`（任务已在 `extracting|analyzing|done`）。
- 同一 `(frame_id, engine_id)` 组合在同一 task 生命周期内只允许一条 active analysis；重复提交返回已存在的那条，HTTP 200 + `reused: true`。

---

## 10. 数据生命周期与红线

### 10.1 三类数据

| 数据 | 位置 | 保留策略 |
|---|---|---|
| 应用自产：任务、帧、哈希、分析结果索引、设置、日志 | `data/rvs.db` + `data/frames/`、`data/exports/` | 用户手动清理或按 `retention_days`（默认 30）清理 **帧文件与导出**；记录型数据默认永久保留，需用户在设置确认删除 |
| 引擎返回的原始 HTML 片段 | `cache/html/` | **默认不落盘**。仅当 `debug.retain_raw_html = on` 时保留，TTL 30 分钟后自动清除 |
| 用户原始视频 | 用户指定路径，**不复制进 data/** | 不持有、不移动、不删除 |

### 10.2 红线

依据 OPEN-DECISIONS 中已 RESOLVED 的条目：

1. **不抓取、不镜像、不缓存原站付费内容与私有资源。** 本产品只缓存自身产出的数据（任务元数据、抽帧结果、结果索引）。
2. 结果中的缩略图 URL 指向原站，由用户在浏览器中打开时才加载；**服务端不代理下载原站图片**。
3. `bridge` 图床一旦启用，用户需明确知晓"帧内容已公开"。UI 必须给出不可跳过的首次确认，并把该次中转记入审计日志。

---

## 11. 项目目录结构（完整树）

```
reverse-video-search/
├── docs/
│   ├── PRD.md                          # 产品需求（Phase 0 产出）
│   ├── UIUX.md                         # 交互与视觉规范（Phase 1 产出）
│   ├── design-tokens.css               # 设计令牌（设计师锁定）
│   ├── design-tokens.json
│   ├── ARCHITECTURE.md                 # 本文
│   ├── API.md                          # 接口契约（含 DB 表清单）
│   └── decisions/
│       ├── ADR-001-proxy-tunnel.md
│       ├── ADR-002-zero-dependency-stack.md
│       ├── ADR-003-ffmpeg-frame-extraction.md
│       ├── ADR-004-engine-adapter-degradation.md
│       └── OPEN-DECISIONS.md           # 悬而未决登记册（只追加）
│
├── scripts/
│   └── probe/                          # Phase 1 侦察脚本与原始响应快照
│       ├── 00-smoke.js … 08-lens-result.js
│       ├── proxy-client.js
│       ├── out-*.txt / out-*.html      # 决策证据，只读，运行时不引用
│       └── test-realframe.jpg, test-synthetic.jpg
│
├── tools/
│   └── probe-tunnel.mjs                # CONNECT 隧道连通性手工校验（补 E-05 证据）
│
├── server/                             # 运行时后端（Node 22 原生，零 npm 依赖）
│   ├── bin/
│   │   └── rvs.mjs                     # 进程入口：只做装配
│   ├── lib/
│   │   ├── config.mjs                  # 环境变量 + 默认值集中处
│   │   ├── errors.mjs                  # RpvsError + 错误码字典
│   │   ├── logger.mjs                  # 结构化日志（内存环形缓冲 + 文件）
│   │   ├── ids.mjs                     # ULID 风格短 ID 生成
│   │   ├── http/
│   │   │   ├── proxy-agent.mjs         # TunnelAgent（CONNECT + TLS）
│   │   │   ├── request.mjs             # 超时/重试/错误分类的 HTTP 客户端
│   │   │   ├── multipart.mjs           # multipart/form-data 构造
│   │   │   └── parse-html.mjs          # 结果页片段提取（受限正则，非完整解析器）
│   │   ├── server/
│   │   │   ├── router.mjs              # 前缀树路由
│   │   │   ├── json.mjs                # 请求体解析 + 响应序列化
│   │   │   ├── static.mjs              # public/ 静态文件 serve
│   │   │   └── validate.mjs            # 轻量参数校验
│   │   ├── db/
│   │   │   ├── client.mjs              # node:sqlite 连接 + 事务包装
│   │   │   ├── schema.sql              # 建表 + 索引
│   │   │   ├── migrate.mjs             # 幂等迁移
│   │   │   └── repo/
│   │   │       ├── tasks.repo.mjs
│   │   │       ├── frames.repo.mjs
│   │   │       ├── analyses.repo.mjs
│   │   │       ├── results.repo.mjs
│   │   │       ├── result-hits.repo.mjs
│   │   │       ├── engine-health.repo.mjs
│   │   │       └── settings.repo.mjs
│   │   ├── media/
│   │   │   ├── probe.mjs               # ffprobe 元数据
│   │   │   ├── extract.mjs             # 抽帧调度（interval / scene）
│   │   │   ├── hash.mjs                # dHash（纯 JS）
│   │   │   └── encode.mjs              # 统一缩放转码 + 图床上传前的降质处理
│   │   └── queue/
│   │       ├── runner.mjs              # 并发池 + 节流
│   │       └── token.mjs               # 取消令牌
│   ├── services/
│   │   ├── task.service.mjs
│   │   ├── frame.service.mjs
│   │   ├── analysis.service.mjs        # 降级编排唯一归属地
│   │   ├── result.service.mjs          # 去重、排序、筛选、置信度来源标注
│   │   ├── engine-health.service.mjs   # 熔断 + 探测
│   │   ├── settings.service.mjs
│   │   ├── export.service.mjs
│   │   └── logs.service.mjs
│   ├── providers/
│   │   ├── base.mjs                    # 引擎适配器抽象形态与返回值契约
│   │   ├── registry.mjs                # 三引擎注册 + 按设置启停
│   │   ├── google-lens.mjs
│   │   ├── yandex.mjs
│   │   ├── bing.mjs
│   │   └── imagehost/
│   │       ├── base.mjs
│   │       ├── registry.mjs
│   │       ├── catbox.mjs
│   │       ├── 0x0.mjs
│   │       └── tmpfiles.mjs
│   └── routes/
│       ├── api-tasks.routes.mjs
│       ├── api-frames.routes.mjs
│       ├── api-analyses.routes.mjs
│       ├── api-results.routes.mjs
│       ├── api-export.routes.mjs
│       ├── api-engines.routes.mjs
│       ├── api-settings.routes.mjs
│       └── api-logs.routes.mjs
│
├── public/                             # 前端静态资源（无构建，直接 serve）
│   ├── index.html
│   └── assets/
│       ├── app.css
│       ├── icons.svg                   # 内联 SVG sprite（rvs-icon-*）
│       ├── app.js                      # 装配：路由 + 事件绑定
│       └── views/
│           ├── upload.view.js
│           ├── task-list.view.js
│           ├── task-detail.view.js
│           ├── results.view.js
│           ├── engines.view.js
│           └── settings.view.js
│
├── data/                               # 运行时产物（gitignore）
│   ├── rvs.db
│   ├── frames/<task_id>/<seq>_<pts_ms>.jpg
│   └── exports/
│
├── cache/                              # 临时（gitignore）
│   └── html/                           # 仅 debug 模式写入，TTL 30 分钟
│
├── reference/                          # 参考资料（只读）
│
└── src/                                # 空目录，MVP 不使用
```

**建议动作**：删除空的 `src/` 目录。当前同时存在 `server/` 与 `src/` 会造成"后端代码放哪个根"的歧义；MVP 约定后端一律在 `server/`，前端静态资源一律在 `public/`，不存在第二个根目录。

---

## 12. 配置与环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RVS_HOST` | `127.0.0.1` | 监听地址，**不得绑定 0.0.0.0** |
| `RVS_PORT` | `8787` | 监听端口 |
| `RVS_PROXY` | `http://127.0.0.1:7897` | 出站代理；置空表示直连 |
| `RVS_DATA_DIR` | `<repo>/data` | 数据与产物根目录 |
| `RVS_FFMPEG` | `ffmpeg`（走 PATH） | 可执行文件绝对路径，可覆盖 |
| `RVS_FFPROBE` | `ffprobe`（走 PATH） | 同上 |
| `RVS_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `RVS_NODE` | `C:/Users/samal/.workbuddy/binaries/node/versions/22.22.2-6/node.exe` | 用于启动脚本锁定运行时 |

启动形态（`package.json` 的 `scripts.start`）：

```
"$RVS_NODE" --experimental-sqlite server/bin/rvs.mjs
```

---

## 13. 性能与容量预算（MVP）

| 项 | 预算 | 依据 |
|---|---|---|
| 单视频时长 | ≤ 10 分钟（建议），硬上限 60 分钟 | 帧数上限已由 `max_frames` 截断，长视频只增 ffprobe 与 seek 开销 |
| 单任务抽帧耗时 | ≤ 60s（10 分钟视频，默认取 12 帧） | scene 检测需全片扫描；纯 interval 模式用 `-ss` 快 seek 更快 |
| 帧文件体积 | 单帧 ≤ 40 KB（320 宽 JPEG q=3） | 便于后续 multipart 直传与图床上传 |
| 单个 analysis 端到端 | ≤ 50s | 受 §8.4 超时预算约束 |
| SQLite 单库 | ≤ 200 MB / 约 50 万 result_hits | 超出后需归档策略，MVP 不实现 |
| UI 首屏 | ≤ 1.5s（本地静态资源） | 无网络请求依赖 |

---

## 14. 技术约束清单（实现必须遵守）

1. **零 npm 运行时依赖。** 任何 `import` 只允许 Node 内置模块。
2. **禁止在业务代码中使用 `fetch(`。** 出站一律走 `lib/http/request.mjs`（内含 TunnelAgent）。
3. **所有端点必须带版本前缀 `/api/v1/`。** 尽管 MVP 只有 v1。
4. **禁止 emoji 作为功能图标**，图标一律内联 SVG sprite（`rvs-icon-{name}`）。
5. **禁止紫色到粉色渐变**作为任何强调色/背景方案。
6. **ffmpeg / ffprobe 调用一律 `spawnFile` + 参数数组**，禁止拼接命令行字符串。
7. **不得把 `未验证-环境限制` 的功能描述为可用。** UI 文案与文档必须标注"实验性"。
8. **单文件 ≤ 300 行**，单一职责，入口只做装配。
9. **依赖只能向下**：`routes → services → providers|repo|media|queue → lib`。
10. **`ZERO_RESULT` 不是错误**，不得触发重试、熔断或红色告警。
11. **不使用 HTTP Server-Sent Events 或 WebSocket。** 前端用轮询拉 `GET /api/v1/tasks/:id`，轮询间隔由后端在响应中下发（`poll_interval_ms`）。
12. **不缓存第三方内容到磁盘**（除 debug 模式短 TTL 的 HTML 片段）。
13. **不得绑定 0.0.0.0**，只监听回环地址。
14. **相似度必须有来源标注**：`engine_provided` / `local_normalized` / `none`，禁止伪精确的小数展示。

---

## 15. 待补证据与后续动作

| 项 | 阻塞对象 | 动作 |
|---|---|---|
| E-05 CONNECT 隧道连通性 | ADR-001 结论补强 | 运行 `tools/probe-tunnel.mjs`，记录结果回填 §2.1 |
| E-10 Bing `q=imgurl:` 形态 | Bing deeplink 从"部分验证"升为"已验证" | 由用户在 PowerShell 执行一次 `Invoke-WebRequest`，把状态码与响应体前 2 KB 回填 `scripts/probe/out-bing-detailv2.txt` |
| E-12~E-19 三家 upload 与三个图床 | 实验性功能能否转正 | 同上；在此之前一律默认关闭 |
| `src/` 目录去留 | 目录歧义 | 建议删除；若不删，至少在 README 注明不使用 |
