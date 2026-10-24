// E2E 预备 B：多编码器兼容——VP9（libvpx-vp9/WebM）与 HEVC（libx265/MP4）夹具走完整抽帧路径。
//
// 为什么值得测：预检（probeMedia）、抽帧（extractAtTime -ss）、dHash、JPEG SOF 解析都在 server 侧，
// 只有 h264 被 05 覆盖。若有人给任一层加 h264 特判（如 codec === 'h264' 才放行、或按 codec 分流超时），
// 本文件会挂。反之，codec 白名单 COMMON_CODECS 含 vp9/hevc（task.service.mjs:11），不应报 codec_unusual。
//
// 夹具分辨率取 640x360（≠ cfg.extract.targetWidth=320），这样"缩放生效"是真缩放而非恒等变换：
// 帧宽高必须落到 320x180。时间戳等距性由 plannedIntervalMs 决定，与编码器无关，作为跨编码器一致性锁。
//
// 本地 ffmpeg 已实测具备 libvpx-vp9 与 libx265（ffmpeg -encoders），故无需跳过；
// 若换环境缺失，对应用例 t.skip 并明确写「跳过：编码器不可用」，不假装通过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  makeClient,
  makeOfflineConfig,
  startApp,
  waitForTaskStatus,
} from './helpers.mjs';
import { probeMedia, spawnBinary } from '../server/lib/media/probe.mjs';

const DHASH_RE = /^[0-9a-f]{16}$/;
const SRC_SIZE = { width: 640, height: 360 };
const FRAME_SIZE = { width: 320, height: 180 };

// 与 helpers.makeTestVideo 同源的三段硬切结构（段内静止 → 有重复帧；段间硬切 → scene 检测有素材），
// 仅改分辨率与编码参数，保证跨编码器可比。
const SEGMENTS = [
  'smptehdbars=s=640x360:d=2:r=10',
  'rgbtestsrc=s=640x360:d=2:r=10',
  'testsrc=s=640x360:d=2:r=10',
];
const CONCAT_FILTER = '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]';

const CODEC_SPECS = [
  {
    key: 'vp9',
    label: 'VP9（libvpx-vp9 / WebM）',
    fileName: 'vp9.webm',
    expectedCodec: 'vp9',
    encoderArgs: [
      '-c:v', 'libvpx-vp9', '-b:v', '800k',
      '-deadline', 'realtime', '-cpu-used', '8',
      '-pix_fmt', 'yuv420p',
    ],
  },
  {
    key: 'hevc',
    label: 'HEVC（libx265 / MP4）',
    fileName: 'hevc.mp4',
    expectedCodec: 'hevc',
    encoderArgs: [
      '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',
    ],
  },
];

// 解析 `ffmpeg -encoders` 输出判断编码器是否编译进本地二进制。
// spawnBinary 成功时 resolve { code, stdout, stderr }；失败（非零退出）reject。
async function detectEncoders() {
  let res;
  try {
    res = await spawnBinary('ffmpeg', ['-hide_banner', '-encoders'], { timeoutMs: 30000 });
  } catch {
    return { ffmpeg: false, vp9: false, hevc: false };
  }
  const text = res.stdout.toString('utf8');
  return {
    ffmpeg: true,
    vp9: text.includes('libvpx-vp9'),
    hevc: text.includes('libx265'),
  };
}

async function makeCodecVideo(dir, spec) {
  const file = path.join(dir, spec.fileName);
  const args = ['-v', 'error'];
  for (const seg of SEGMENTS) args.push('-f', 'lavfi', '-i', seg);
  args.push('-filter_complex', CONCAT_FILTER, '-map', '[v]', ...spec.encoderArgs, '-t', '6', file, '-y');
  await spawnBinary('ffmpeg', args, { timeoutMs: 120000 });
  return file;
}

describe('E2E 预备 B：多编码器兼容（VP9 / HEVC 走完整抽帧路径）', () => {
  /** @type {{ffmpeg:boolean, vp9:boolean, hevc:boolean}} */
  let caps = { ffmpeg: false, vp9: false, hevc: false };
  /** @type {{tmp:string, fixtures:Record<string,{file:string,codec:string,duration_ms:number}>}} */
  let shared = { tmp: '', fixtures: {} };

  before(async () => {
    caps = await detectEncoders();
    if (!caps.ffmpeg) return; // 无 ffmpeg：所有用例走 skip，不做任何假装
    shared.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rvs-codec-'));
    for (const spec of CODEC_SPECS) {
      if (!caps[spec.key]) continue;
      const file = await makeCodecVideo(shared.tmp, spec);
      // 夹具自检：ffprobe 必须报出目标编码器。防止"编码器名写错导致静默回退 h264"造成假阳性。
      const meta = await probeMedia(
        { ffprobe: 'ffprobe', media: { probeTimeoutMs: 20000 } },
        file,
      );
      shared.fixtures[spec.key] = { file, codec: meta.codec, duration_ms: meta.duration_ms };
    }
  });

  after(() => {
    if (shared.tmp) fs.rmSync(shared.tmp, { recursive: true, force: true });
  });

  function skipIfUnavailable(t, spec) {
    if (!caps.ffmpeg) return t.skip('跳过：本地 ffmpeg 不可用');
    if (!caps[spec.key]) return t.skip(`跳过：编码器不可用（${spec.label} 未编译进本地 ffmpeg）`);
    return null;
  }

  // 建任务 + 抽帧 + 各模式共用的一套断言。
  // expectDuplicates：仅 interval 模式成立——它会在同一静止段内取多个点（如 0/1500ms 都在 smptehdbars 段），
  // 必有重复帧；scene 模式只取硬切点（2000/4000ms 分属 rgbtestsrc/testsrc 两段），内容本就不同，不得断言有重复。
  async function assertExtractPipeline(t, spec, { mode, maxFrames, expectStep, expectCount, expectDuplicates }) {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const fixture = shared.fixtures[spec.key];
    const created = await api.post('/api/file-upload', {
      source_type: 'file',
      source_path: fixture.file,
      display_name: spec.fileName,
      extract_mode: mode,
      max_frames: maxFrames,
    });
    assert.equal(created.status, 201, `期望 201，实际 ${created.status} ${created.text.slice(0, 300)}`);
    const taskId = created.json?.data?.task?.id;
    assert.ok(taskId, '必须返回 task_id');

    // ---- 预检：codec / duration / 分辨率必须按夹具原样取到 ----
    const task0 = created.json.data.task;
    assert.equal(task0.codec, spec.expectedCodec,
      `预检 codec 应为 ${spec.expectedCodec}，实际 ${task0.codec}（夹具自检 codec=${fixture.codec}）`);
    assert.equal(task0.width, SRC_SIZE.width, `预检宽度应为 ${SRC_SIZE.width}，实际 ${task0.width}`);
    assert.equal(task0.height, SRC_SIZE.height, `预检高度应为 ${SRC_SIZE.height}，实际 ${task0.height}`);
    assert.ok(task0.duration_ms > 0, '预检必须取到时长');
    assert.equal(created.json.data.plan.estimated_frames > 0, true, '预检必须给出抽帧预估');
    assert.equal(created.json.data.plan.warnings.includes('codec_unusual'), false,
      `vp9/hevc 在 COMMON_CODECS 白名单内，不应告警 codec_unusual，实际 ${JSON.stringify(created.json.data.plan.warnings)}`);

    // ---- 抽帧 ----
    const extract = await api.post(`/api/tasks/${taskId}/extract`, { mode, max_frames: maxFrames });
    assert.equal(extract.status, 202, `期望 202，实际 ${extract.status} ${extract.text.slice(0, 300)}`);
    const done = await waitForTaskStatus(api, taskId, 'frames_ready');
    assert.equal(done.ffmpeg_error, null, `抽帧不应报错，实际 ${done.ffmpeg_error}`);
    assert.ok(done.frames_done > 0, `${spec.label} ${mode} 模式必须产出帧`);
    // 抽帧后 task 上的元数据应与预检一致（不被编码器带偏）
    assert.equal(done.codec, spec.expectedCodec);
    assert.equal(done.width, SRC_SIZE.width);
    assert.equal(done.height, SRC_SIZE.height);

    const framesRes = await api.get(`/api/tasks/${taskId}/frames`);
    assert.equal(framesRes.status, 200);
    const frames = framesRes.json?.data?.items || [];
    assert.ok(frames.length > 0 && frames.length <= maxFrames,
      `帧数应在 (0, ${maxFrames}]，实际 ${frames.length}`);
    if (expectCount !== undefined) {
      assert.equal(frames.length, expectCount,
        `${spec.label} ${mode} 模式帧数应为 ${expectCount}，实际 ${frames.length}（times=${JSON.stringify(frames.map((f) => f.time_ms))}）`);
    }

    // ---- 尺寸：源 640x360 → cfg.extract.targetWidth=320 真缩放生效 ----
    for (const f of frames) {
      assert.equal(f.width, FRAME_SIZE.width,
        `${spec.label} 帧宽应为 ${FRAME_SIZE.width}（源 ${SRC_SIZE.width} 经 scale 缩放），实际 ${f.width}`);
      assert.equal(f.height, FRAME_SIZE.height,
        `${spec.label} 帧高应为 ${FRAME_SIZE.height}（源 ${SRC_SIZE.height} 经 scale=-2 缩放），实际 ${f.height}`);
      assert.match(f.dhash, DHASH_RE, `dhash 必须是 16 位十六进制：${f.dhash}`);
      assert.equal(typeof f.time_ms, 'number');
      assert.equal(f.preview_url, `/frames/${taskId}/${f.file_name}`);
    }

    // ---- 时间戳：等距（interval 语义）或非降序 + 含场景点（scene/both 语义）----
    const times = frames.map((f) => f.time_ms);
    if (mode === 'interval') {
      assert.equal(times[0], 0, 'interval 模式首个取点应为 0');
      const diffs = times.slice(1).map((v, i) => v - times[i]);
      assert.ok(diffs.length > 0, 'interval 模式应有多帧');
      assert.ok(diffs.every((d) => d === diffs[0] && d > 0),
        `${spec.label} interval 时间戳应严格等距，实际 diffs=${JSON.stringify(diffs)}`);
      if (expectStep !== undefined) {
        assert.equal(diffs[0], expectStep,
          `${spec.label} interval 步长应为 ${expectStep}ms（plannedIntervalMs），实际 ${diffs[0]}`);
      }
    } else {
      const sorted = [...times].sort((a, b) => a - b);
      assert.deepEqual(times, sorted, `${spec.label} ${mode} 时间戳必须非降序`);
      // scene 检测必须真的贡献取点：三段硬切在 2000/4000ms，必然偏离 1500ms 等距网格。
      const offGrid = times.filter((v) => v % 1500 !== 0);
      assert.ok(offGrid.length > 0,
        `${spec.label} ${mode} 模式应含场景切换点（非 1500 网格），实际 times=${JSON.stringify(times)}——` +
        '若为 0 说明 scene 检测静默回退 interval');
    }

    // ---- 帧文件真落盘且可经本地 HTTP 读为 JPEG ----
    const frameDir = path.join(cfg.framesDir, taskId);
    for (const f of frames) {
      assert.ok(fs.existsSync(path.join(frameDir, f.file_name)), `帧文件必须落盘：${f.file_name}`);
    }
    const image = await api.get(frames[0].preview_url);
    assert.equal(image.status, 200, '帧图必须可经本地 HTTP 读取');
    assert.match(image.headers['content-type'] || '', /image\/jpeg/);

    // ---- 帧内去重分组 ----
    assert.ok(frames.every((f) => typeof f.dup_group === 'number' && f.dup_group >= 1), '每帧必须归入去重组');
    assert.ok(frames.every((f) => f.is_duplicate === 0 || f.is_duplicate === 1), 'is_duplicate 必须是 0/1');
    if (expectDuplicates) {
      assert.ok(frames.some((f) => f.is_duplicate === 1),
        `${spec.label} ${mode} 模式在同一静止段内取多点，必须识别出重复帧（dHash 跨编码器一致工作），` +
        `实际 times=${JSON.stringify(times)} dup_groups=${JSON.stringify(frames.map((f) => f.dup_group))}`);
    }

    return { api, taskId, frames };
  }

  test('B0：编码器能力探测如实反映本地 ffmpeg（缺失即跳过，不假装通过）', (t) => {
    // 本用例永远执行（不需要 ffmpeg 也能跑）：锁住探测函数本身的行为契约。
    assert.equal(typeof caps.ffmpeg, 'boolean');
    assert.equal(typeof caps.vp9, 'boolean');
    assert.equal(typeof caps.hevc, 'boolean');
    if (!caps.ffmpeg) {
      t.diagnostic('本地 ffmpeg 不可用：B1/B2/B4 将全部 skip');
      return;
    }
    t.diagnostic(`能力探测结果：vp9=${caps.vp9} hevc=${caps.hevc}`);
    // 夹具自检：只有探测到可用的编码器才应有对应夹具，且 ffprobe 报出的 codec 与期望一致
    for (const spec of CODEC_SPECS) {
      if (!caps[spec.key]) {
        assert.equal(shared.fixtures[spec.key], undefined, `${spec.key} 不可用却造了夹具`);
        continue;
      }
      const fixture = shared.fixtures[spec.key];
      assert.ok(fixture?.file && fs.existsSync(fixture.file), `${spec.key} 夹具应已生成`);
      assert.equal(fixture.codec, spec.expectedCodec,
        `${spec.key} 夹具 ffprobe codec 应为 ${spec.expectedCodec}，实际 ${fixture.codec}`);
      assert.ok(fixture.duration_ms > 0, `${spec.key} 夹具应有正时长`);
    }
  });

  for (const spec of CODEC_SPECS) {
    test(`B1-${spec.key}：${spec.label} interval 抽帧（尺寸缩放 + 时间戳等距 + dHash）`, async (t) => {
      const skipped = skipIfUnavailable(t, spec);
      if (skipped) return;
      await assertExtractPipeline(t, spec, { mode: 'interval', maxFrames: 6, expectStep: 1500, expectCount: 4, expectDuplicates: true });
    });

    test(`B2-${spec.key}：${spec.label} scene/both 模式（非 h264 解码路径的场景检测）`, async (t) => {
      const skipped = skipIfUnavailable(t, spec);
      if (skipped) return;
      // scene：三段硬切 → 只取切换点
      await assertExtractPipeline(t, spec, { mode: 'scene', maxFrames: 6, expectCount: 2 });
      // both：场景点 + 等距补足 → 6 点（mergeTimes minGap=300 不会合并掉 2000/4000）
      await assertExtractPipeline(t, spec, { mode: 'both', maxFrames: 6, expectCount: 6 });
    });
  }

  test('B4：同一实例先后处理两种编码器，帧产物与元数据互不串味', async (t) => {
    const skipped = skipIfUnavailable(t, CODEC_SPECS[0]);
    if (skipped) return;
    const skipped2 = skipIfUnavailable(t, CODEC_SPECS[1]);
    if (skipped2) return;

    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const perCodec = {};
    for (const spec of CODEC_SPECS) {
      const created = await api.post('/api/file-upload', {
        source_type: 'file',
        source_path: shared.fixtures[spec.key].file,
        display_name: spec.fileName,
        extract_mode: 'interval',
        max_frames: 2,
      });
      assert.equal(created.status, 201, `${spec.label} 建任务应 201，实际 ${created.status} ${created.text.slice(0, 200)}`);
      const taskId = created.json.data.task.id;
      await api.post(`/api/tasks/${taskId}/extract`, { mode: 'interval', max_frames: 2 });
      await waitForTaskStatus(api, taskId, 'frames_ready');
      const frames = (await api.get(`/api/tasks/${taskId}/frames`)).json.data.items;
      perCodec[spec.key] = { spec, taskId, frames };
    }

    // 1. 两个任务的元数据必须各自对应自己的编码器，不能互换或串写
    assert.equal(perCodec.vp9.spec.expectedCodec, 'vp9');
    assert.equal(perCodec.hevc.spec.expectedCodec, 'hevc');
    assert.notEqual(perCodec.vp9.taskId, perCodec.hevc.taskId, '两个任务 ID 不得相同');

    // 2. 帧 ID 不得跨任务重复
    const vp9Ids = new Set(perCodec.vp9.frames.map((f) => f.id));
    const crossOver = perCodec.hevc.frames.filter((f) => vp9Ids.has(f.id));
    assert.deepEqual(crossOver, [], 'HEVC 任务的帧 ID 不得出现在 VP9 任务里');

    // 3. 磁盘产物按任务分目录，互不串文件
    for (const key of ['vp9', 'hevc']) {
      const { taskId, frames, spec } = perCodec[key];
      const ownDir = path.join(cfg.framesDir, taskId);
      const onDisk = fs.readdirSync(ownDir).filter((f) => f.endsWith('.jpg')).sort();
      const expected = frames.map((f) => f.file_name).sort();
      assert.deepEqual(onDisk, expected,
        `${spec.label} 的 frames/<taskId>/ 内容应与该任务帧行一一对应，实际磁盘 ${JSON.stringify(onDisk)} vs DB ${JSON.stringify(expected)}`);
      for (const f of frames) {
        assert.equal(f.width, FRAME_SIZE.width, `${spec.label} 帧宽不得被另一编码器带偏`);
        assert.equal(f.height, FRAME_SIZE.height, `${spec.label} 帧高不得被另一编码器带偏`);
      }
    }

    // 4. 详情接口上的 codec 仍各自独立（防止模块级缓存把 vp9 写成 hevc）
    for (const key of ['vp9', 'hevc']) {
      const { taskId, spec } = perCodec[key];
      const detail = (await api.get(`/api/tasks/${taskId}`)).json.data.task;
      assert.equal(detail.codec, spec.expectedCodec,
        `${spec.label} 任务详情的 codec 应保持 ${spec.expectedCodec}，实际 ${detail.codec}`);
    }
  });
});
