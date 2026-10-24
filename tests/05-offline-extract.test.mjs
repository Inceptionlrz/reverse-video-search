// SPEC §14 验收项 11：完全离线时仍可完成本地预检与抽帧（PRD EARS #26）。
// 这是最关键的一条：网络不可用不得阻塞任何本地功能。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  makeClient,
  makeOfflineConfig,
  makeTestVideo,
  startApp,
  waitForTaskStatus,
  zeroOutbound,
} from './helpers.mjs';

const DHASH_RE = /^[0-9a-f]{16}$/;

describe('SPEC §14 验收项 11：完全离线下本地预检与抽帧可用', () => {
  test('验收项11：RVS_OFFLINE=1 下预检 + interval 抽帧 + dHash + 去重全流程可用（EARS #26）', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const video = await makeTestVideo(tmp);
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    // 1) 本地预检：ffprobe 元数据，全程不触网
    const created = await api.post('/api/file-upload', {
      source_type: 'file',
      source_path: video,
      display_name: 'offline-fixture.mp4',
      extract_mode: 'interval',
      max_frames: 5,
    });
    assert.equal(created.status, 201, `期望 201，实际 ${created.status} ${created.text}`);
    const taskId = created.json?.data?.task?.id;
    assert.ok(taskId, '必须返回 task_id');
    assert.ok(created.json.data.task.duration_ms > 0, '预检必须取到时长');
    assert.ok(created.json.data.task.width > 0 && created.json.data.task.height > 0, '预检必须取到分辨率');
    assert.equal(created.json.data.task.codec, 'h264');
    assert.equal(created.json.data.plan.estimated_frames > 0, true, '预检必须给出抽帧预估');
    assert.equal(zeroOutbound(app), true, '预检阶段零外发');

    // 2) 抽帧（interval）
    const extract = await api.post(`/api/tasks/${taskId}/extract`, { mode: 'interval', max_frames: 5 });
    assert.equal(extract.status, 202, `期望 202，实际 ${extract.status} ${extract.text}`);

    const done = await waitForTaskStatus(api, taskId, 'frames_ready');
    assert.ok(done, '任务必须到达 frames_ready');
    assert.equal(done.status, 'frames_ready');
    assert.ok(done.frames_done > 0, `frames_done 应大于 0，实际 ${done.frames_done}`);
    assert.equal(done.ffmpeg_error, null);

    // 3) 帧列表：dhash / 时间戳 / 预览地址齐全
    const framesRes = await api.get(`/api/tasks/${taskId}/frames`);
    assert.equal(framesRes.status, 200);
    const frames = framesRes.json?.data?.items || [];
    assert.ok(frames.length > 0, '离线也必须产出帧');
    assert.ok(frames.length <= 5, `帧数不得超过上限 5，实际 ${frames.length}`);
    for (const frame of frames) {
      assert.match(frame.dhash, DHASH_RE, `dhash 必须是 16 位十六进制：${frame.dhash}`);
      assert.equal(typeof frame.time_ms, 'number', '每帧必须有毫秒级时间戳');
      assert.equal(frame.preview_url, `/frames/${taskId}/${frame.file_name}`);
      assert.equal(frame.width, 320, '帧按 320 宽统一缩放');
    }

    // 4) 帧文件真的落盘且可经 HTTP 读取
    for (const frame of frames) {
      const file = path.join(cfg.framesDir, taskId, frame.file_name);
      assert.ok(fs.existsSync(file), `帧文件必须落盘：${file}`);
    }
    const image = await api.get(frames[0].preview_url);
    assert.equal(image.status, 200, '帧图必须可经本地 HTTP 读取');
    assert.match(image.headers['content-type'] || '', /image\/jpeg/);

    // 5) 帧内去重已分组（三段测试源段内静止，必有重复帧）
    assert.ok(frames.some((f) => f.is_duplicate === 1), '静止段内必须识别出重复帧');
    assert.ok(frames.every((f) => typeof f.dup_group === 'number' && f.dup_group >= 1), '每帧必须归入去重组');

    // 6) 离线全程零外发
    assert.equal(zeroOutbound(app), true, JSON.stringify(app.metrics.providerRequests));
  });

  test('验收项11：scene 模式离线可用，且无场景变化时回退固定间隔而非返回空（EARS #26）', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const video = await makeTestVideo(tmp, 'scene-fixture.mp4');
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const created = await api.post('/api/file-upload', {
      source_type: 'file',
      source_path: video,
      display_name: 'scene-fixture.mp4',
      max_frames: 4,
    });
    assert.equal(created.status, 201);
    const taskId = created.json.data.task.id;

    // both：先场景后补足（三段硬切，scene 检测应命中）
    const extract = await api.post(`/api/tasks/${taskId}/extract`, { mode: 'both', max_frames: 4 });
    assert.equal(extract.status, 202);
    const done = await waitForTaskStatus(api, taskId, 'frames_ready');
    assert.ok(done.frames_done > 0, 'both 模式离线也必须产出帧');
    assert.equal(done.status, 'frames_ready');

    const frames = (await api.get(`/api/tasks/${taskId}/frames`)).json.data.items;
    assert.ok(frames.length > 0 && frames.length <= 4);
    assert.ok(frames.every((f) => DHASH_RE.test(f.dhash)));

    // 高阈值 scene（几乎不可能命中）→ 必须回退固定间隔，不得静默返回 0 帧
    const retry = await api.post(`/api/tasks/${taskId}/extract`, { mode: 'scene', max_frames: 3, scene_threshold: 0.9 });
    assert.equal(retry.status, 202);
    const fallback = await waitForTaskStatus(api, taskId, 'frames_ready');
    assert.ok(fallback.frames_done > 0, 'scene 未命中时必须回退固定间隔，不得返回空任务');
    assert.equal(zeroOutbound(app), true);
  });

  test('验收项11：文件损坏时预检给出可操作原因且不触网（EARS #26）', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const broken = path.join(tmp, 'broken.mp4');
    fs.writeFileSync(broken, Buffer.from('this is not a video at all', 'utf8'));
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const res = await api.post('/api/file-upload', {
      source_type: 'file',
      source_path: broken,
      display_name: 'broken.mp4',
    });
    // 预检失败：HTTP 400 + 明确错误码 + ffmpeg 摘要，而不是"未知错误"
    assert.equal(res.status, 400, `期望 400，实际 ${res.status} ${res.text}`);
    assert.equal(res.json?.error?.code, 'MEDIA_ERROR');
    assert.ok(String(res.json?.error?.detail?.ffmpeg || '').length > 0, '必须带 ffmpeg 诊断摘要');
    assert.equal(zeroOutbound(app), true);
  });
});
