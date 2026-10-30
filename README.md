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
| Bing 图片 | 已验证（端到端复跑见下） | 未验证（端点实测 400/404） | 已验证 | **配好 GitHub 图床即可自动** |
| Yandex 图片 | 未验证 | 未验证 | 未验证 | 会尝试，结果不保证 |
| Google Lens | 实测不可用 | 端点接受上传 | 不可用 | **只能手动** |

**关键前提**：Bing / Yandex 的自动链路都要一个**公网可直取的图片 URL**，
而这个 URL 只能来自图床。所以「能不能自动」实际取决于「有没有可用图床」，
不是勾选一个开关就能自动——见下节实测结论。

**为什么 Google Lens 不能自动**：它的结果页是纯 JS 应用外壳。
实测 `POST /v3/upload`（字段名 `encoded_image`）返回 **303 并跳转到真实结果页地址**——上传是被接受的；
但跟进该跳转拿到的是 `<noscript>` 跳 `enablejs` 的空壳，`AF_initDataCallback` / `/url?q=` / `data-ved` 全部 0 命中，
外壳内没有任何数据端点。结果全靠客户端 JS 渲染，HTTP 层拿不到。带与不带 cookie 复测结论一致
（证据：`scripts/probe/18-lens-cookie.mjs` 与 `out-H-*.html`）。
不逆向其内部 RPC（极脆弱），也不引入完整浏览器（与零依赖设计冲突）。

Lens 这一路的手动成本已尽量压低：任务详情页 → **手动跑腿工作台**，按帧聚合，
点「复制帧图片」把帧写进剪贴板，到 Lens 上传页按 `Ctrl+V`；或直接把缩略图拖到上传区。

## 图床实测结论（2026-10-30）

三家内置匿名图床**此前从未对真实服务发过一个字节**（适配器头部都写着「形态存在，
未验证返回值」），却在设置与授权弹窗里当可选项提供——勾了才发现全降到手动。
现已逐个实测（`scripts/probe/19-imagehost.mjs`、`20-bridge-e2e.mjs`）：

| 图床 | 上传 | 链接形态 | 能否用于桥接 |
|---|---|---|---|
| catbox.moe | **412 Invalid uploader** | 有账号则返回 `files.catbox.moe` 直链图片 | 需自备免费账号（填 `RVS_CATBOX_USERHASH`） |
| tmpfiles.org | **200 成功**（约 1.7s） | `text/html` 预览页，不是图片；`/dl/<id>` 404 | 不能——引擎取不到图 |
| 0x0.st | TLS 连接即断开 | — | 不能——不可达 |

另测过 litterbox（"No file!"）、uguu.se（不稳）、pixeldrain（401 需 key）、
telegra.ph（400）、bashupload / envs.sh / oshi.at（不可达）：**当前没有可用的匿名图床**。

### GitHub 图床：当前唯一实测跑通的方案

与其再赌一家第三方，改用你自己已经拥有的 GitHub（Contents API 提交 + `raw.githubusercontent.com` 直链）：

```bash
export RVS_GITHUB_TOKEN=ghp_xxx        # 需 Contents 写权限
export RVS_GITHUB_REPO=owner/repo
export RVS_GITHUB_BRANCH=frames        # 默认；建议用孤立分支，与主分支历史隔离
```

端到端实测（2026-10-30，`scripts/probe/20-bridge-e2e.mjs`）：

```
[1] 上传: ok=true status=201
    直链: https://raw.githubusercontent.com/<repo>/frames/2026-10-30/probe-xxx.jpg
[2] 检索: ok=true status=200 items=35 耗时=1579ms
出站请求数: 图床=1 引擎=4
桥接链路可用
```

**代价必须说清**：帧会**公开可见**并**留在 git 历史里**（删掉分支历史才消失）。
所以默认用孤立分支 `frames`，既不污染主分支历史，也不触发 Pages 重建。

### 顺带修掉的三个「假成功 / 误导」

- **深链死代码**（最严重）：Bing 深链返回 302，而 `request()` 不自动跟随 3xx、
  且 3xx 不是 `res.ok`。旧代码把 `if (!res.ok) return` 写在跟随分支之前，
  302 在第一跳就被判失败——**后面整段跟随代码永不执行**。界面写「页面结构无法解析」，
  真实原因却是「压根没跟到结果页」。跟随分支已上提到基类 `searchByDeeplink`，
  并改用实测可达的 `view=detailv2` 形态（旧形态跟随后是 404）。
- 图床返回链接后**必须校验 `content-type` 为 `image/*`** 才放行
  （`classifyImageUrl`）。否则 tmpfiles 那种 HTML 预览页会被当成成功，
  引擎拿网页去搜图 → 36 个组合跑完全是空结果，而失败原因还写成"解析失败"。
- 412 不再归为 `PARSE_ERROR`：界面会写成「图床拒绝上传」而不是「页面结构无法解析」。

另修一处**配置静默失效**：超时配置存在 `cfg.net.*`，而 `request()` 读的是顶层
`cfg.connectTimeoutMs`——把预算从 1s 放宽到 3s 后实际仍按 1s 走，
表现为「代理只是慢，却被判代理不可达」。现由 `resolveTimeouts()` 统一解析，
两种形态都认，并有测试钉死（`tests/20-redirect-follow.test.mjs`）。

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

## 线上地址与仓库

- 仓库：https://github.com/Inceptionlrz/reverse-video-search
- 项目页（GitHub Pages）：https://inceptionlrz.github.io/reverse-video-search/

**注意：Pages 上的只是项目介绍页，不是可直接使用的服务。** 本工具必须跑在
**你自己的机器上**——它要读写本地视频文件、抽帧、把帧外发给搜索引擎，
且服务端强制只绑定回环地址（`RVS_HOST` 非回环直接拒绝启动）。这些性质决定了
它无法 hosted 化：任何公网部署都意味着把你的视频交给第三方服务器。
Pages 站点的作用是说明项目、给出安装与验证步骤。

### 常用环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `RVS_PORT` | `4173` | 监听端口 |
| `RVS_HOST` | `127.0.0.1` | **只允许回环地址**，非回环直接拒绝启动 |
| `RVS_DATA_DIR` | `<项目>/data` | 数据库、帧、导出目录 |
| `RVS_FFMPEG` / `RVS_FFPROBE` | `ffmpeg` / `ffprobe` | 二进制路径或命令名 |
| `RVS_CATBOX_USERHASH` | 空 | catbox 账号 hash。匿名上传已被拒（412），填了才可能用 |
| `RVS_GITHUB_TOKEN` / `RVS_GITHUB_REPO` / `RVS_GITHUB_BRANCH` | 空 / 空 / `frames` | GitHub 图床。三者中 token 与 repo 都设了才启用（当前唯一实测跑通的图床） |
| `RVS_NET_*_TIMEOUT_MS` | 3000/8000/10000/30000 | 隧道/TLS/首字节/整体超时。走慢代理时可调 |
| `RVS_PROXY` | `http://127.0.0.1:7897` | 出站代理；不需要外网时设为空串 |
| `RVS_OFFLINE` | `0` | `1` = 完全离线，不发任何外网请求 |

## 测试

```bash
npm test        # 单元 + 契约 + 端到端（离线运行，不发起真实外发）
npm run smoke   # 端到端冒烟，校验 HTTP 行为
```

测试全部离线运行（`RVS_OFFLINE=1`）。**需要 ffmpeg 的用例在二进制缺失时会明确跳过并说明原因**，
不会伪装成通过——装好 ffmpeg 后重跑即可覆盖。

## 移动端

手机浏览器可用。响应式断点 1279 / 1023 / 767px：

| 宽度 | 形态 |
|---|---|
| ≤1279px | 收起检视栏，主区两栏 |
| ≤1023px | 侧栏收成 56px 图标条，多列网格降为单列 |
| ≤767px | 侧栏变**底部导航**，帧列表转横向滚动，弹窗高度按 `dvh` 收 |

已处理的具体问题（均为 Chromium 实测，非纸面推断）：

- **整页横滚（最严重）**：`.app`/`.app__body` 的网格列是隐式 `auto` / `1fr`，基准尺寸取内容
  最小尺寸，容器装不下时轨道反而被顶宽——实测 320px 视口下轨道 488px，顶栏、底栏导航、
  主区全部溢出。所有布局列改为 `minmax(0, 1fr)` 后归位。
- **状态栏顶宽布局视口**：`.statusbar__item` 是 `nowrap` 等宽文本，三项合计 362px，
  把移动端 `window.innerWidth` 从 320 撑到 362（底栏导航跟着变宽、整页横滚）。
  窄屏隐去 SQLite 项、收紧间距并允许省略号。
- **顶栏文字被切半截**：引擎名胶囊被 `overflow: hidden` 切成 "Googl"/"Yande"/"Bin"；
  品牌名因 `min-width: 0` 缩到竖排折行。窄屏改为品牌名不换行、版本号与引擎条让位。
- **触控目标**：`pointer: coarse` 下 `button`/`a`/`[role=button]` 与
  `input`（复选框除外）/`select`/`textarea` 全部 ≥44px 高
- **内联宽度**：筛选控件的 `width` 写在内联 style 上，媒体查询覆盖不掉，
  断点内用 `!important` 强制 100%（本仓库 `!important` 的唯一用途）
- **安全区**：底部导航与主区净空计入 `env(safe-area-inset-bottom)`，避开 iPhone home indicator
- **遮挡**：Toast 抬到底部导航之上（原本 z-index 1300 会整个盖住导航）；
  弹窗 `max-height` 从 86dvh 收到 `78dvh - 安全区`，避免底部压在导航条下

### 移动端怎么验的

`scripts/mobile-audit.mjs` —— Chromium 无头真机审计，覆盖 320/360/390/414/768/1280 六档
视口 × 5 条路由，检查四项：横向滚动、元素越界、触控目标 <44px、底栏遮挡，
并输出截图到 `out/mobile/`。

```bash
npm i -D playwright && npx playwright install chromium   # 仅核查用，不进依赖
node --experimental-sqlite server/bin/rvs.mjs            # 另开终端起服务
node scripts/mobile-audit.mjs http://127.0.0.1:4173      # 无问题则退出码 0
```

**不属于 `npm test`**：跑它要下载浏览器，而本项目刻意保持零运行时依赖，所以它是人工
核查工具而非门禁。四项检查都做过变异验证（回退修复后确实报警），避免"永远绿"的假检查。

## 目录结构

```
server/          分层：routes → services → lib（db/repo、media、queue）
  providers/     三个搜索引擎适配器 + 降级可用性标注
  services/      task / frame / analysis / settings / export / telemetry
public/          零构建前端：原生 ESM + 内联 SVG sprite + Token 化 CSS
tests/           18 个测试文件（84 用例），含契约测试与变异验证
scripts/probe/   引擎端点实测探针与产物（结论的证据来源）
docs/            PRD / 架构 / UIUX / API / SPEC / ADR / 未决项 + Pages 站点首页
```

跑全量测试：

```bash
npm test
# 84 tests / 84 pass / 0 fail（需 ffmpeg）
# ffmpeg 不在 PATH 时：RVS_FFMPEG=/path/to/ffmpeg RVS_FFPROBE=/path/to/ffprobe npm test
```

设计约束：单文件 ≤ 300 行、入口只做装配、依赖只向下、禁止硬编码 hex、禁止渐变与弹跳缓动。

## 已知边界

- 只绑定回环地址，不对外暴露；没有账号体系，单机自用。
- 引擎可达性依赖对方网页结构，任何一家改版都可能让自动链路失效——失效时降级为手动，并在降级日志里写明原因，不会静默失败。
- 浏览器级渲染验证**不进 `npm test`**（要下载 Chromium，与零依赖取向冲突）。改了视图渲染或
  响应式断点后，请手工跑一次 `scripts/mobile-audit.mjs`；它不检查视觉审美，
  被 `overflow: hidden` 裁掉的半截文字也仍可能漏网，截图建议顺带扫一眼。

## 许可

仓库内未附加开源许可证文件；如需在外部使用或分发，请先与作者确认。
