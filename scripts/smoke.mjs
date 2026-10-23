// 离线冒烟：不依赖浏览器、不依赖外网，验证本地全链路。
//   建任务 → ffprobe 预检 → 抽帧 → dHash → 帧内去重 → 导出 CSV/JSON → 清理
// 用法：node --experimental-sqlite scripts/smoke.mjs [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/lib/config.mjs';
import { createApp } from '../server/app.mjs';
import { spawnBinary } from '../server/lib/media/probe.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const PASS = [];
const FAIL = [];

function check(name, condition, detail = '') {
  if (condition) {
    PASS.push(name);
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    FAIL.push(name);
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function makeTestVideo(dir) {
  const file = path.join(dir, 'smoke-input.mp4');
  // 三段结构差异明显的测试源（实测 dHash 两两距离 27~35，远超阈值 6）：
  //   smptehdbars（彩条）/ rgbtestsrc（渐变）/ testsrc（经典图案），各 2 秒。
  // 段内静止 → 验证帧内去重分组；段间差异大 → 验证不同组；段边界 → 验证 scene 检测。
  const args = [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'smptehdbars=s=320x180:d=2:r=10',
    '-f', 'lavfi', '-i', 'rgbtestsrc=s=320x180:d=2:r=10',
    '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=2:r=10',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]',
    '-pix_fmt', 'yuv420p',
    '-t', '6',
    file, '-y',
  ];
  await spawnBinary('ffmpeg', args, { timeoutMs: 60000 });
  return file;
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rvs-smoke-'));
  const cfg = loadConfig(
    {
      RVS_DATA_DIR: path.join(tmpRoot, 'data'),
      RVS_OFFLINE: '1',
      RVS_LOG_LEVEL: 'warn',
      RVS_PORT: '0',
    },
    REPO_ROOT,
  );
  console.log(`[smoke] 临时数据目录：${cfg.dataDir}`);

  const video = await makeTestVideo(tmpRoot);
  console.log('[smoke] 测试视频已生成');

  const app = await createApp({ config: cfg });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const api = async (method, urlPath, body) => {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 非 JSON（导出接口）保持原文
    }
    return { status: res.status, json, text };
  };

  try {
    console.log('\n== 1. 健康检查 ==');
    const health = await api('GET', '/api/health');
    check('GET /api/health 返回 200', health.status === 200, `status=${health.status}`);
    check('health 报告离线模式', health.json?.data?.offline === true);
    check('health 报告回环地址', health.json?.data?.host === '127.0.0.1');

    console.log('\n== 2. 建任务（JSON 本地路径） ==');
    const created = await api('POST', '/api/file-upload', {
      source_type: 'file',
      source_path: video,
      display_name: 'smoke.mp4',
      extract_mode: 'interval',
      max_frames: 5,
    });
    check('建任务返回 201', created.status === 201, `status=${created.status}`);
    const taskId = created.json?.data?.task?.id;
    check('返回 task_id', Boolean(taskId), taskId || created.text.slice(0, 200));
    check('预检取到时长', Number(created.json?.data?.task?.duration_ms) > 0, `duration_ms=${created.json?.data?.task?.duration_ms}`);

    console.log('\n== 3. 抽帧 ==');
    const extract = await api('POST', `/api/tasks/${taskId}/extract`, { mode: 'interval', max_frames: 5 });
    check('抽帧返回 202', extract.status === 202, `status=${extract.status}`);
    let frames = [];
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const detail = await api('GET', `/api/tasks/${taskId}`);
      if (detail.json?.data?.task?.status === 'frames_ready') break;
      if (detail.json?.data?.task?.status === 'failed') break;
    }
    const framesRes = await api('GET', `/api/tasks/${taskId}/frames`);
    frames = framesRes.json?.data?.items || [];
    check('帧列表非空', frames.length > 0, `frames=${frames.length}`);
    check('每帧有 dhash', frames.every((f) => typeof f.dhash === 'string' && f.dhash.length === 16));
    check('每帧有 time_ms', frames.every((f) => Number.isFinite(f.time_ms)));
    check('帧有预览 URL', frames.every((f) => typeof f.preview_url === 'string' && f.preview_url.startsWith('/frames/')));
    const frameFile = path.join(cfg.framesDir, taskId, frames[0]?.file_name || '');
    check('帧文件落盘', fs.existsSync(frameFile), frameFile);
    const first = await fetch(`${base}${frames[0].preview_url}`);
    check('帧图可经 HTTP 读取', first.status === 200 && (first.headers.get('content-type') || '').includes('image/jpeg'));

    console.log('\n== 4. 批量启停帧 ==');
    const patched = await api('PATCH', `/api/tasks/${taskId}/frames`, { frame_ids: [frames[1].id], enabled: false });
    check('PATCH 帧启停返回 200', patched.status === 200);
    const after = await api('GET', `/api/tasks/${taskId}/frames`);
    check('禁用态已生效', (after.json?.data?.items || []).find((f) => f.id === frames[1].id)?.enabled === 0);

    console.log('\n== 5. 离线模式下的分析（必须零外网请求，落 manual） ==');
    const confirmed = await api('POST', `/api/tasks/${taskId}/confirm`, { engines: true });
    check('确认外发返回 200', confirmed.status === 200);
    const run = await api('POST', '/api/search/run-analyses', { task_id: taskId, consent_ack: true });
    check('run-analyses 返回 202', run.status === 202, `status=${run.status} ${run.text.slice(0, 160)}`);
    const analyses = run.json?.data?.analyses || [];
    // 用 PATCH 之后的最新帧列表计算预期（第 4 步禁用过 frames[1]，旧快照会高估可分析帧数）。
    const analyzable = (after.json?.data?.items || frames).filter((f) => f.enabled === 1 && f.is_duplicate === 0);
    check('生成 帧×引擎 分析作业', analyses.length === analyzable.length * 3, `analyses=${analyses.length} expected=${analyzable.length * 3}`);
    check('帧内去重已分组', frames.some((f) => f.is_duplicate === 1), `dup=${frames.filter((f) => f.is_duplicate === 1).length}`);
    let settled = [];
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const list = await api('GET', `/api/tasks/${taskId}/analyses`);
      settled = list.json?.data?.items || [];
      if (settled.length && settled.every((a) => ['succeeded', 'zero_result', 'manual', 'failed', 'cancelled'].includes(a.status))) break;
    }
    check('全部分析已终态', settled.length > 0 && settled.every((a) => a.status !== 'queued' && a.status !== 'running'), `n=${settled.length}`);
    check('离线模式全部落 manual', settled.every((a) => a.status === 'manual'), settled.map((a) => a.status).join(','));
    check('manual 带错误码（永不为空）', settled.every((a) => typeof a.error_code === 'string' && a.error_code.length > 0));
    check('降级日志可展开', settled.every((a) => Array.isArray(a.degradation_log) && a.degradation_log.length > 0));
    check('provider 请求计数为 0（离线零外发）', Object.values(app.metrics.providerRequests).every((n) => n === 0), JSON.stringify(app.metrics.providerRequests));

    console.log('\n== 6. 导出 ==');
    const csv = await fetch(`${base}/api/export.csv?task_id=${taskId}`);
    const csvBuf = Buffer.from(await csv.arrayBuffer());
    const csvText = csvBuf.toString('utf8');
    check('CSV 返回 200', csv.status === 200);
    check('CSV 带 BOM', csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf, `前3字节=${[...csvBuf.slice(0, 3)].join(',')}`);
    check('CSV 表头为数据字段语义', csvText.includes('线索分') && csvText.includes('分数来源') && !csvText.includes('排序分'));
    check('CSV 无概率/准确性措辞', !/准确率|概率/.test(csvText));
    const jsonExport = await fetch(`${base}/api/export.json?task_id=${taskId}`);
    const jsonText = await jsonExport.text();
    const parsed = JSON.parse(jsonText);
    check('JSON 导出可解析', jsonExport.status === 200 && parsed.schema_version === 1);
    check('JSON 含生成时间与筛选', typeof parsed.generated_at === 'string' && parsed.filters.task_id === taskId);

    console.log('\n== 7. 引擎状态与设置 ==');
    const engines = await api('GET', '/api/engines');
    check('三家引擎在册', (engines.json?.data?.engines || []).length === 3, engines.json?.data?.engines?.map((e) => e.id).join(','));
    check('Lens 深链标记不可用', engines.json?.data?.engines?.find((e) => e.id === 'google_lens')?.availability?.deeplink === 'unavailable');
    const settings = await api('GET', '/api/settings');
    check('设置含只读镜像', typeof settings.json?.data?.read_only?.network?.proxy !== 'undefined');
    check('图床默认开但未选站点', settings.json?.data?.writable?.imagehost?.enabled === true && settings.json?.data?.writable?.imagehost?.provider === null);

    console.log('\n== 8. 删除任务 ==');
    const del = await api('DELETE', `/api/tasks/${taskId}`);
    check('删除任务返回 200', del.status === 200);
    check('帧目录已清理', !fs.existsSync(path.join(cfg.framesDir, taskId)));
  } finally {
    await app.close();
    if (!KEEP) fs.rmSync(tmpRoot, { recursive: true, force: true });
    else console.log(`[smoke] 保留临时目录：${tmpRoot}`);
  }

  console.log(`\n[smoke] 通过 ${PASS.length} 项，失败 ${FAIL.length} 项`);
  if (FAIL.length) {
    console.log(`[smoke] 失败项：${FAIL.join(' | ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[smoke] 未处理异常：${err.stack || err}`);
  process.exit(1);
});
