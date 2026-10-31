// 手动跑腿工作台回归：既然 Google Lens 只能手动（结果页是纯 JS 外壳，HTTP 抓不到，
// 证据 scripts/probe/18-lens-cookie.mjs），就要把手动的成本压到最低。
//
// 本文件锁三件事：
//   1) 按帧聚合：一帧 × N 引擎只出现一组，不是 N 条独立条目；
//   2) 每个组合必须给到「复制帧图片」这类真正省事的出口，而不只是给个上传页链接；
//   3) 帧图必须能被浏览器拿到（preview_url 存在），否则剪贴板/拖放都无从谈起。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { installDomStub, stubFindAll, stubText } from './helpers.mjs';
import { openManualRunbook } from '../public/assets/views/manual-runbook.view.js';
import { manualCopyTargets } from '../public/assets/views/shared.view.js';


const FRAMES = [
  { id: 'f1', seq: 1, time_ms: 1000, enabled: true, file_name: 'f1.jpg', preview_url: '/frames/t1/f1.jpg' },
  { id: 'f2', seq: 2, time_ms: 3000, enabled: true, file_name: 'f2.jpg', preview_url: '/frames/t1/f2.jpg' },
];

const ANALYSES = [
  // f1 上有两个 manual（Lens + Yandex）——必须聚成一组，而不是两条
  { id: 'a1', frame_id: 'f1', frame_seq: 1, provider: 'google_lens', status: 'manual', manual_path: 'D:/frames/f1.jpg', manual_url: 'https://lens.google.com/' },
  { id: 'a2', frame_id: 'f1', frame_seq: 1, provider: 'yandex', status: 'manual', manual_path: 'D:/frames/f1.jpg', manual_url: null },
  // 非 manual 不得进入工作台
  { id: 'a3', frame_id: 'f2', frame_seq: 2, provider: 'bing', status: 'succeeded' },
  // f2 上有一个 manual
  { id: 'a4', frame_id: 'f2', frame_seq: 2, provider: 'google_lens', status: 'manual', manual_path: 'D:/frames/f2.jpg', manual_url: 'https://lens.google.com/' },
];

describe('手动跑腿工作台', () => {
  test('R1：按帧聚合——一帧多引擎只出一组，组内每引擎一行', () => {
    const uninstall = installDomStub();
    try {
      openManualRunbook({ analyses: ANALYSES, frames: FRAMES });
      // 工作台是 append 到 body 的，取最后一次渲染的容器
      const groups = stubFindAll(document.body, 'runbook__group');
      assert.equal(groups.length, 2, `应按帧聚成 2 组，实测 ${groups.length}`);

      const first = stubText(groups[0]);
      assert.match(first, /第 1 帧/, '第一组应是第 1 帧');
      assert.match(first, /Google Lens/, '组内应出现 Lens');
      assert.match(first, /Yandex 图片/, '组内应出现 Yandex');

      const second = stubText(groups[1]);
      assert.match(second, /第 2 帧/, '第二组应是第 2 帧');
      assert.ok(!/Bing/.test(second), 'succeeded 的 Bing 不应进入工作台');
    } finally {
      uninstall();
    }
  });

  test('R2：每个组合都要有省事的出口——复制图片链接 / 打开上传页 / 复制本地路径', () => {
    const uninstall = installDomStub();
    try {
      openManualRunbook({ analyses: ANALYSES, frames: FRAMES });
      const groups = stubFindAll(document.body, 'runbook__group');
      const rows = [];
      for (const g of groups) {
        for (const r of stubFindAll(g, 'consent-row')) rows.push(stubText(r));
      }
      assert.equal(rows.length, 3, `共 3 个待手动组合，实测 ${rows.length}`);

      // 有 manual_url 的组合必须给上传页入口
      assert.ok(rows.some((r) => /打开上传页|打开结果页/.test(r)), '至少一个组合应有上传页入口');
      // 有 preview_url 的组合必须给剪贴板出口——这是把「手动」变便宜的关键
      const withCopy = rows.filter((r) => /复制帧图片/.test(r));
      assert.equal(withCopy.length, 3, '三个组合都有 preview_url，都应提供复制帧图片');
      // 复制本地路径始终兜底。
      // 文案必须写明是"本地"：曾叫「复制帧路径」，用户点了以为拿到的是图片链接。
      assert.equal(rows.filter((r) => /复制本地路径/.test(r)).length, 3, '复制本地路径应始终可用作兜底');
    } finally {
      uninstall();
    }
  });

  test('R2b：复制链接必须给公网直链，绝不能给本机磁盘路径', () => {
    // 用户反馈：点了复制却拿到 D:\...\001_0.jpg 这种本机磁盘路径。
    // 取值走 manualCopyTargets 这个纯函数（按钮是 DOM 事件绑定的，
    // stub 的 addEventListener 是 no-op，点不到），因此这里能真正钉住内容。
    // 需要 DOM stub：safeHttpUrl 要用 location.origin 解析 URL。
    const uninstall = installDomStub();
    try {
      const PUBLIC_URL = 'https://raw.githubusercontent.com/o/r/frames/2026-10-30/f1.jpg';
      const t = manualCopyTargets({
        manual_path: 'D:/frames/f1.jpg',
        request_url: PUBLIC_URL,
      });
      assert.equal(t.link, PUBLIC_URL, 'link 应是图床公网直链');
      assert.equal(t.path, 'D:/frames/f1.jpg', 'path 才是本机路径');
      assert.notEqual(t.link, t.path, '两者绝不能是同一个值——否则用户拿到的还是本地路径');
      assert.ok(!String(t.link || '').includes('D:/'), 'link 里不得掺进本机磁盘路径');
    } finally {
      uninstall();
    }
  });

  test('R2c：没有图床直链时 link 为 null（界面据此不显示复制链接按钮）', () => {
    assert.equal(manualCopyTargets({ manual_path: 'D:/f.jpg', request_url: null }).link, null);
    assert.equal(manualCopyTargets({}).link, null);
    assert.equal(manualCopyTargets({}).path, '', '什么都没有时 path 为空串，不写 undefined 进剪贴板');
  });

  test('R2d：工作台在有直链时确实渲染出「复制链接」按钮', () => {
    const uninstall = installDomStub();
    try {
      const PUBLIC_URL = 'https://raw.githubusercontent.com/o/r/frames/2026-10-30/f1.jpg';
      openManualRunbook({
        analyses: [{
          id: 'a1', frame_id: 'f1', frame_seq: 1, provider: 'google_lens', status: 'manual',
          manual_path: 'D:/frames/f1.jpg',
          manual_url: `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(PUBLIC_URL)}`,
          request_url: PUBLIC_URL,
          degradation_log: [{ step: 'manual_deeplink', ok: true }],
        }],
        frames: FRAMES,
      });
      const groups = stubFindAll(document.body, 'runbook__group');
      const text = stubText(groups[0]);
      assert.match(text, /复制链接/, '有公网直链时应出现复制链接按钮');
      assert.match(text, /打开结果页/, 'manual_deeplink 成功时文案应说明打开的是结果页');
    } finally {
      uninstall();
    }
  });

  test('R3：没有 preview_url 时不得假称能复制图片', () => {
    const uninstall = installDomStub();
    try {
      openManualRunbook({
        analyses: [{ id: 'x', frame_id: 'zz', frame_seq: 9, provider: 'google_lens', status: 'manual', manual_path: 'D:/frames/zz.jpg' }],
        frames: [{ id: 'zz', seq: 9, time_ms: 0, file_name: 'zz.jpg', preview_url: null }],
      });
      const groups = stubFindAll(document.body, 'runbook__group');
      assert.equal(groups.length, 1);
      const text = stubText(groups[0]);
      assert.ok(!/复制帧图片/.test(text), '拿不到帧图时不能给复制图片按钮（点了只会报错）');
      // 文案必须写明是"本地"：曾叫「复制帧路径」，用户以为那是图片链接。
      assert.match(text, /复制本地路径/, '应退回复制本地路径');
    } finally {
      uninstall();
    }
  });

  test('R4：没有待手动项时给空态，不抛错', () => {
    const uninstall = installDomStub();
    try {
      openManualRunbook({ analyses: [{ id: 'y', frame_id: 'f1', provider: 'bing', status: 'succeeded' }], frames: FRAMES });
      const groups = stubFindAll(document.body, 'runbook__group');
      assert.equal(groups.length, 0, '没有 manual 项时不应有分组');
      assert.match(stubText(document.body), /当前没有待手动的组合/, '应显示空态文案');
    } finally {
      uninstall();
    }
  });

  test('R5：缩略图必须可拖拽（拖到引擎上传页是真实的 File 拖放）', () => {
    const uninstall = installDomStub();
    try {
      openManualRunbook({ analyses: ANALYSES, frames: FRAMES });
      const thumbs = stubFindAll(document.body, 'runbook__thumb');
      assert.equal(thumbs.length, 2, '两组各一张缩略图');
      for (const t of thumbs) {
        assert.equal(t.draggable, true, '缩略图必须可拖拽');
        assert.match(String(t.title || ''), /引擎上传页/, '拖拽提示要说明用途');
      }
    } finally {
      uninstall();
    }
  });

  test('R6：任务详情页必须把 frames 一起传下去（否则拿不到 preview_url）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'public/assets/views/task-detail.view.js'), 'utf8');
    assert.match(src, /openManualRunbook\(\{\s*analyses: state\.analyses,\s*frames: state\.frames\s*\}\)/,
      '调用必须同时传 analyses 与 frames，漏传 frames 会让复制图片/拖放全部失效');
  });
});
