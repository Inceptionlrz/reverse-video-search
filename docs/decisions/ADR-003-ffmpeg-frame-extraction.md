# ADR-003: 使用 ffmpeg 命令行抽帧，并用纯 JS 计算 dHash

## Status

Accepted（2026-10-24）

## Background

产品需要从视频中取出若干代表性帧，并对这些帧做帧内去重。可用的前置条件：

- 本机有 ffmpeg / ffprobe **8.1.1** 且已在 `PATH`（实测可用）。
- **没有** `sharp`、`jimp`、`canvas` 等图像处理库可用；按 ADR-002，也不允许引入。

因此"解码视频"和"处理位图"这两件事必须分头解决：解码交给 ffmpeg，位图处理要么也交给 ffmpeg，要么用纯 JS 做。

## Decision

### 一、抽帧全部交给 ffmpeg 命令行，且全部引用已实测的命令形态

| 环节 | 命令 | 实测证据 |
|---|---|---|
| 元数据 | `ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate,codec_name -of default=nw=1 <file>` | E-20：返回 `codec_name=h264`、`width=320`、`height=180`、`r_frame_rate=15/1`、`duration=6.000000` |
| 固定间隔 | `ffmpeg -v error -i <f> -vf "fps=fps=1/1.5,scale=320:-2" -q:v 3 -frames:v 5 out/f_%03d.jpg -y` | E-21：6 秒视频产出 **4 张** |
| 场景检测 | `ffmpeg -v info -i <f> -filter:v "select='gt(scene,0.25)',showinfo" -f null -`，从 stderr 正则提取 `pts_time:([0-9.]+)` | E-22：含 2 秒处硬切的视频精确返回 `pts_time:2` |
| 定点导出 | `ffmpeg -ss <t> -i <f> -frames:v 1 -q:v 3 -vf "scale=320:-2" out.jpg -y`（`-ss` 在 `-i` 之前，走快 seek） | E-23：定点导出成功 |

三种策略：

- `interval`：一条 `fps` 过滤器取完，最快。
- `scene`：先跑一遍全片 scene 检测拿到时间点数组，再对每个时间点跑一次 `-ss` 快 seek 导出。**需要全片扫描，是慢路径**。
- `both`：先 `scene`，数量不足 `max_frames` 时用 `interval` 补足，合并后按 `pts_ms` 排序去重。默认策略。

所有输出帧统一 `scale=320:-2` + `-q:v 3`，单帧约 20 - 40 KB。

### 二、dHash 由 ffmpeg 出图 + Node 纯 JS 计算，不引入任何图像库

```
ffmpeg -v error -i <frame> -vf "scale=9:8,format=gray" -f rawvideo -pix_fmt gray -
```

输出恰好 72 字节（9 宽 × 8 高，每像素 1 字节灰度）。Node 侧逻辑：

```
for row in 0..7:
  for col in 0..7:
    bit = buf[row*9 + col] > buf[row*9 + col + 1] ? 1 : 0
    hash = (hash << 1) | bit
```

得到 64 bit，按 16 位十六进制字符串存入 `frames.dhash`。整个计算约 15 行代码，零依赖。

被否决的备选：

| 备选 | 否决理由 |
|---|---|
| 引入 `sharp` / `jimp` | ADR-002 明确零依赖；且本机不可解析风险同 E-01 |
| pHash（DCT 版本） | 需要二维 DCT 实现约 120 行且要做数值调优，MVP 阶段 dHash 的去重精度已足够；留作后续 ADR |
| 直接用 ffmpeg 的 `signature` 滤镜做全片比对 | 它服务的是"两段视频是否同源"，不是"单次抽帧结果集内的精细去重"，粒度不匹配 |
| 用帧文件大小做去重 | 不可靠，压缩率受画面复杂度影响远大于内容相似性 |

### 三、去重规则

相邻帧汉明距离 **≤ 6**（`hash.hamming_threshold` 可配）归为同一 `dhash_group`，组内保留 `pts_ms` 最小的一帧，其余 `is_duplicate = 1`。去重只影响**默认分析范围**：用户在 UI 上勾选"包含重复帧"后可全部纳入。

## Consequences

正面：

- 抽帧与哈希在同一套已实测的 ffmpeg 命令上完成，可复现性高。
- dHash 逻辑极短，可读可审计，不依赖二进制模块。
- 帧文件统一 320 宽 JPEG q=3，便于后续 multipart 直传与图床上传。

负面：

- 每次调用都创建子进程。`both` 策略下是 `1 + N` 次调用，10 分钟视频取 12 帧约 13 次进程创建，耗时可达 60s。**缓解**：单任务抽帧串行且全局并发上限默认 1，避免 CPU 抖动。
- `-v info` 的 scene 检测依赖 stderr，stderr 不可预测大小。**缓解**：`maxBuffer: 8 MiB`，超出中止并按 `PARSE_ERROR` 归类。
- dHash 对旋转、裁剪、亮度大幅变化不鲁棒，可能出现"看起来一样但哈希距离远"。**缓解**：本产品的去重目的是减少冗余分析请求，误判为"不重复"的代价只是多花一次请求，可接受。
- 场景阈值 `0.25` 是实测硬切视频的有效值，但对渐变转场可能过度触发。**缓解**：阈值暴露为 `scene_threshold` 配置，UI 可调。

## 安全约束

所有 ffmpeg / ffprobe 调用一律 `spawnFile(file, argsArray, options)`，**禁止拼接命令行字符串**。用户输入的文件路径可能含空格、引号或以 `-` 开头，字符串拼接会被解析为 ffmpeg 参数，构成参数注入。

## Related ADRs

- ADR-002：本决策是零依赖选型在媒体层的直接结果
