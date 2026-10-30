// 取消竞态回归：control{action:'cancel'} 必须真正中断在飞工作，而不只是改数据库状态。
//
// 缺陷原貌（实证）：抽帧链路从未注册取消令牌——cancelTokens 这个 Map 全仓库只有
// get() 没有 set()，frameService 也不接受令牌。于是 cancel 只把 tasks.status 写成
// cancelled，ffmpeg 继续跑完 8 帧，末尾又把状态翻回 frames_ready：用户点了取消，
// 界面显示 cancelled 十几秒，最后却拿到满帧，算力白耗。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ffprobeBin, makeClient, makeOfflineConfig, mediaBinariesReady, requireMedia, startApp } from './helpers.mjs';
import { spawnBinary } from '../server/lib/media/probe.mjs';
import { createCancelToken } from '../server/lib/queue/token.mjs';

const FFMPEG = process.env.RVS_FFMPEG || 'ffmpeg';

async function makeVideo(dir, name, seconds) {
  const file = path.join(dir, name);
  await spawnBinary(FFMPEG, [
    '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=25:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file, '-y',
  ], { timeoutMs: 120000 });
  return file;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// T1：取消令牌必须真的终止 ffmpeg 子进程（而非等它自然结束）
describe('取消竞态（commit 取消令牌接入抽帧链路）', () => {
  test('T1：abort 后 ffmpeg 子进程立即被杀——promise 以“已取消”拒绝', async (t) => {
    // T1 直接 spawn ffmpeg 造负重进程，没有 cfg 可传，所以走裸探测。
    // 缺件时若不跳过，报错会是 ENOENT 而断言却期望「已取消」——失败原因被带偏。
    // ffprobe 同样要读 env：写死 'ffprobe' 的话，只设了 RVS_FFPROBE 的机器
    // 会探测失败 → T1 被误跳过（正是上一轮 83/1 的来源）。
    if (!(await mediaBinariesReady({ ffmpeg: FFMPEG, ffprobe: ffprobeBin() })).ok) {
      t.skip('跳过：本地 ffmpeg 不可用');
      return;
    }
    const token = createCancelToken();
    // 全片解码 300 秒素材：本机实测自然耗时约 19 秒，是取消耗时的百倍量级，
    // 因此“是否在 8 秒内返回”足以区分「被杀」与「跑完」。
    const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=640x480:d=300:r=30', '-f', 'null', '-'];

    const started = Date.now();
    const run = spawnBinary(FFMPEG, args, { timeoutMs: 60000, cancelToken: token });
    await sleep(150);
    token.abort('user cancelled');

    let rejected = null;
    try {
      await run;
    } catch (err) {
      rejected = err;
    }
    const elapsed = Date.now() - started;

    assert.ok(rejected, '取消后 spawnBinary 必须拒绝，不能正常 resolve');
    assert.match(String(rejected.message), /取消/, `拒绝原因应表明是取消，实际：${rejected.message}`);
    assert.ok(elapsed < 8000, `取消应在毫秒级生效（实测 ${elapsed}ms，自然耗时约 19000ms）——接近自然耗时即说明进程没被杀`);
  });

  // T2：端到端——抽帧途中取消，状态不得被抽帧回调翻回 frames_ready
  test('T2：抽帧途中取消——最终状态保持 cancelled，且不落任何帧', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });
    if (!(await requireMedia(t, cfg))) return;

    const dir = fs.mkdtempSync(path.join(tmp, 'cancel-'));
    // 素材必须足够“重”：本机实测该规格抽 8 帧约需 14 秒，取消落在 300ms 时
    // 抽帧必然还在进行中，用例才有意义（用小素材会跑完后才被取消，退化成空测）。
    const source = await makeVideo(dir, 'clip60.mp4', 60);

    const api = makeClient(app.server.address().port);
    const created = await api.post('/api/file-upload', {
      source_type: 'file',
      source_path: source,
      display_name: '取消竞态',
      extract_mode: 'interval',
      max_frames: 8,
    });
    assert.equal(created.json?.ok, true, `建任务失败：${created.text?.slice(0, 200)}`);
    const taskId = created.json.data.task.id;

    await api.post(`/api/tasks/${taskId}/extract`, {});
    await sleep(300); // 落在抽帧进行中：8 帧 × 每次 ffmpeg 起进程，远不止 300ms

    const cancel = await api.post(`/api/tasks/${taskId}/control`, { action: 'cancel' });
    assert.equal(cancel.json?.ok, true, '取消应成功');

    // 轮询至终态。注意不能一见 status==='cancelled' 就跳出：控制器先把状态改成
    // cancelled，异步抽帧链路随后才补写 ffmpeg_error——早退会读到 null 的空档。
    // 修复前这里会等来 frames_ready（取消被抽帧回调覆盖，即缺陷现场）。
    let final = null;
    for (let i = 0; i < 60; i += 1) {
      const d = await api.get(`/api/tasks/${taskId}`);
      final = d.json?.data?.task;
      if (!final) break;
      if (final.status === 'cancelled' && final.ffmpeg_error === '用户取消') break;
      if (['frames_ready', 'failed'].includes(final.status)) break;
      await sleep(500);
    }

    assert.equal(final?.status, 'cancelled', `取消后最终状态必须是 cancelled，实测 ${final?.status}`);
    assert.equal(final?.ffmpeg_error, '用户取消', '取消应记为“用户取消”，而不是笼统的失败');
    assert.equal(final?.frames_done, 0, '取消后不得落任何帧');

    const framesDir = path.join(cfg.framesDir, taskId);
    const leftovers = fs.existsSync(framesDir) ? fs.readdirSync(framesDir) : [];
    assert.equal(leftovers.length, 0, `帧目录应为空（实测残留 ${leftovers.length} 个文件）`);
  });

  // T3：取消与真实失败必须区分——不取消时失败仍应是 failed
  test('T3：抽帧真实失败仍记 failed——取消分支不得吞掉真实错误', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });
    if (!(await requireMedia(t, cfg))) return;

    // 建任务阶段 ffprobe 会拒绝损坏文件，拿不到任务；改为「建任务成功后再抽走源文件」，
    // 让失败发生在抽帧阶段，才能验证取消分支没有吞掉真实错误。
    const dir = fs.mkdtempSync(path.join(tmp, 'broken-'));
    const source = await makeVideo(dir, 'clip.mp4', 2);

    const api = makeClient(app.server.address().port);
    const created = await api.post('/api/file-upload', {
      source_type: 'file',
      source_path: source,
      display_name: '源文件被抽走',
    });
    assert.equal(created.json?.ok, true, `建任务失败：${created.text?.slice(0, 200)}`);
    const taskId = created.json.data.task.id;
    fs.rmSync(source, { force: true });

    await api.post(`/api/tasks/${taskId}/extract`, {});

    let final = null;
    for (let i = 0; i < 40; i += 1) {
      const d = await api.get(`/api/tasks/${taskId}`);
      final = d.json?.data?.task;
      if (final && ['frames_ready', 'failed', 'cancelled'].includes(final.status)) break;
      await sleep(500);
    }

    assert.equal(final?.status, 'failed', `损坏文件应走到 failed，实测 ${final?.status}`);
    assert.ok(final?.ffmpeg_error, '失败应记录 ffmpeg 错误信息');
    assert.notEqual(final?.ffmpeg_error, '用户取消', '真实失败不得被误标为用户取消');
  });
});
