# OPEN-DECISIONS 悬而未决登记册

> 只追加 + 就地关闭（OPEN → RESOLVED 并补 Resolution）。每次 Phase 开始时复现到工作上下文最前面。

| Date | Source | Open Item | Related Constraints | Current Leaning | Blocked By | Resolves When | Status |
|------|--------|-----------|---------------------|-----------------|------------|---------------|--------|
| 2026-10-24 | Phase 0 | 需求第 3 条要求「抓取、镜像或缓存原站付费内容与私有资源」 | 服务条款 / 著作权 / 用户明确红线；原站结果依赖登录令牌+积分 | 拒绝执行该子项；改为独立实现 + 仅缓存本应用自产数据 | 用户确认调整 | 已与用户说明，按调整后范围推进 | RESOLVED |
| 2026-10-24 | Phase 1 | Bing Visual Search 的 multipart 直传端点是否真实可用 | 本环境 Node 进程出站 HTTPS 被 MITM 桩响应劫持，仅 PowerShell Invoke-WebRequest 可取真实响应 | 若无法验证则标注「未验证」，适配器留降级位，不硬编未验证端点 | 端点实测 | 架构师回传实测结论 | OPEN |
| 2026-10-24 | Phase 1 | Google Lens `v3/upload` 字段名与可用性 | 同上；且 Lens 无公开 API | 优先 `uploadbyurl`（需公网 URL），直传仅作可选路径 | 端点实测 | 架构师回传实测结论 | OPEN |
| 2026-10-24 | Phase 1 | 本地服务在 127.0.0.1，三家引擎均要求公网可达图片 URL | 无公网 URL 时 URL 模式不可用 | 优先 multipart 直传；图床桥接作为可选且需用户显式开启 | 端点实测 + 用户偏好 | 架构师回传后定 | OPEN |
| 2026-10-24 | Phase 1 | Node 内置 fetch 不支持代理（`NODE_USE_ENV_PROXY` 实测无效、`undici` 不可解析） | 用户网络需走 127.0.0.1:7897 | 自研零依赖 HTTP(S) over CONNECT 隧道，代理走 `RVS_PROXY` 配置 | — | 架构师锁定 | RESOLVED（待 ADR 落定） |
| 2026-10-24 | Phase 1 | 相似度口径：引擎排序位置信度 vs 本地感知哈希实算 | 公开引擎不返回真实相似度分数 | 双轨展示 + 标注分数来源（`引擎提供`/`本地归一化`/`无分数`），禁止伪精确 | 用户已选 | 用户已选「两者合并展示」 | RESOLVED |
| 2026-10-24 | Phase 1 | 感知哈希实现是否零依赖自研 | 无 sharp/jimp 时需手写 dHash/pHash | 借用 ffmpeg 输出固定尺寸灰度图，Node 侧纯 JS 算 64bit dHash | 架构师实测 | 架构师回传 | OPEN |
