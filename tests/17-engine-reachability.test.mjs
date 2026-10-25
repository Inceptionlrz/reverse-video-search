// 引擎可达性前置告知回归：确认弹窗必须在「发起之前」就说清哪些引擎只能手动跑腿。
//
// 缺陷原貌（用户实跑 21 个帧×引擎组合全部降级为 manual）：
// 弹窗只列出引擎名字，没有任何可达性标注。Google Lens 无法用纯 HTTP 自动化
// （结果页为纯 JS 应用外壳，复测证据 scripts/probe/18-lens-cookie.mjs 与 out-H-*.html），
// 意味着 Lens 这一路必然手动——但用户要等 21 个作业跑完、在降级日志里翻 skip 理由才知道，
// 白等一整轮。
//
// 本文件把「UI 标注」与「后端 availability」钉在一起：
//   - 纯函数侧：engineReachability 的判定顺序必须与执行层四级链路同序；
//   - 契约侧：直接拿 live /api/engines 的 availability 喂给同一函数，
//     保证后端调整可达性标注后，前端展示不会停在旧答案上。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  REPO_ROOT, installDomStub, makeClient, makeOfflineConfig, startApp, stubFindAll, stubText,
} from './helpers.mjs';
import {
  engineReachability, engineReachRows, publicHttpUrl,
} from '../public/assets/views/shared.view.js';

// 与后端默认设置保持同构（server/services/settings.service.mjs DEFAULTS）：
// Lens 的 deeplink/upload 默认关，且 availability 已标记不可用。
const ENGINES = [
  { id: 'google_lens', enabled: true, availability: { deeplink: 'unavailable', upload: 'unverified', bridge: 'unavailable' } },
  { id: 'bing', enabled: true, availability: { deeplink: 'verified', upload: 'unverified', bridge: 'verified' } },
  { id: 'yandex', enabled: true, availability: { deeplink: 'unverified', upload: 'unverified', bridge: 'unverified' } },
];

const DEFAULT_MODES = {
  google_lens: { deeplink: false, upload: false },
  yandex: { deeplink: true, upload: false },
  bing: { deeplink: true, upload: false },
};

const only = (id) => ENGINES.filter((e) => e.id === id);
const pathOf = (id, opts) => engineReachability(only(id), opts)[0];

describe('引擎可达性前置告知（Lens 只能手动跑腿）', () => {
  test('E1：bridge 实测不可用的引擎必须标「需手动跑腿」——不得混在可自动里', () => {
    // 这是用户实跑踩到的核心：Lens 与 Bing 曾一律显示「可自动」。
    const lens = pathOf('google_lens', { imagehost: { enabled: true, provider: 'catbox' }, engineModes: DEFAULT_MODES });
    assert.equal(lens.path, 'manual', 'Lens 无任何自动路径，path 应为 manual');
    assert.equal(lens.tone, 'warn');
    assert.match(lens.label, /需手动/, `Lens 文案必须写明需手动，实际：${lens.label}`);

    const bing = pathOf('bing', { imagehost: { enabled: true, provider: 'catbox' }, engineModes: DEFAULT_MODES });
    assert.equal(bing.path, 'bridge', '同样设置下 Bing 应能走桥接');
    assert.equal(bing.tone, 'ok');

    // 关键：两者标签不得相同，否则用户看不出区别
    assert.notEqual(lens.label, bing.label, 'Lens 与 Bing 的可达性文案必须可区分');
  });

  test('E2：直传开启且引擎支持时，直传优先于深链与桥接', () => {
    const uploadable = [{ id: 'bing', enabled: true, availability: { deeplink: 'verified', upload: 'verified', bridge: 'verified' } }];
    const r = engineReachability(uploadable, {
      imagehost: { enabled: true, provider: 'catbox' },
      engineModes: { bing: { deeplink: true, upload: true } },
      publicUrl: 'https://example.com/a.jpg', // 深链本来也通，仍应让位给直传
    })[0];
    assert.equal(r.path, 'upload');
    assert.equal(r.tone, 'ok');

    // 开关关着时不算可达——默认设置里 upload 全是 false
    const off = engineReachability(uploadable, {
      imagehost: { enabled: true, provider: 'catbox' },
      engineModes: { bing: { deeplink: true, upload: false } },
    })[0];
    assert.notEqual(off.path, 'upload');
  });

  test('E3：图床开了但没选站点——应提示「在下方选站点」，而不是判死', () => {
    const r = pathOf('bing', { imagehost: { enabled: true, provider: null }, engineModes: DEFAULT_MODES });
    assert.equal(r.path, 'bridge_no_site');
    assert.equal(r.tone, 'idle');
    assert.match(r.label, /选站点/, `应指引用户去选站点，实际：${r.label}`);
  });

  test('E4：图床总开关关着——应区分「开了就能自动」与「天生走不通」', () => {
    const bing = pathOf('bing', { imagehost: { enabled: false, provider: 'catbox' }, engineModes: DEFAULT_MODES });
    assert.equal(bing.path, 'manual', '桥接关着时 Bing 只剩手动');
    assert.match(bing.label, /开启桥接后可自动/, `应给出可恢复路径，实际：${bing.label}`);

    const lens = pathOf('google_lens', { imagehost: { enabled: true, provider: 'catbox' }, engineModes: DEFAULT_MODES });
    assert.equal(lens.label, '需手动跑腿', 'Lens 是能力不可用，不该暗示开启桥接就能救');
  });

  test('E5：URL 来源任务有公网地址且深链可用时，应判为深链', () => {
    const r = pathOf('yandex', {
      imagehost: { enabled: true, provider: 'catbox' },
      engineModes: DEFAULT_MODES,
      publicUrl: 'https://example.com/a.jpg',
    });
    assert.equal(r.path, 'deeplink', 'URL 来源 + 深链可用应优先走深链');
  });

  test('E6：内网 / 本机地址不算公网——深链不得因此被判为可达', () => {
    for (const u of ['http://127.0.0.1/a.jpg', 'http://localhost/a.jpg', 'http://192.168.1.5/a.jpg', 'file:///tmp/a.jpg']) {
      const r = pathOf('yandex', {
        imagehost: { enabled: true, provider: 'catbox' },
        engineModes: DEFAULT_MODES,
        publicUrl: u,
      });
      assert.notEqual(r.path, 'deeplink', `${u} 不是公网地址，深链不应可达`);
    }
    assert.equal(publicHttpUrl('https://example.com/a.jpg'), 'https://example.com/a.jpg');
    assert.equal(publicHttpUrl('not a url'), null);
  });

  test('E7：未启用的引擎不出现在可达性行里', () => {
    const rows = engineReachability(
      [...ENGINES, { id: 'bing', enabled: false, availability: { bridge: 'verified' } }],
      { imagehost: { enabled: true, provider: 'catbox' }, engineModes: DEFAULT_MODES },
    );
    assert.equal(rows.length, 3, '停用引擎应被过滤');
  });

  test('E8：入参缺失时不得抛错（设置读失败的降级路径）', () => {
    assert.deepEqual(engineReachability(null), []);
    assert.deepEqual(engineReachability(undefined, undefined), []);
    const r = pathOf('bing', {}); // 没有 imagehost / engineModes
    assert.equal(r.path, 'manual');
  });
});

describe('可达性与后端 availability 的一致性（拿 live 数据反喂 UI 判定）', () => {
  test('E9：live /api/engines 的 availability 喂给 UI 后，不可用的引擎必须标手动', async (t) => {
    const { cfg } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });

    const api = makeClient(app.server.address().port);
    const res = await api.get('/api/engines');
    assert.equal(res.json?.ok, true, '前置：引擎列表应可取');
    const engines = res.json?.data?.engines || res.json?.data?.items;
    assert.ok(Array.isArray(engines) && engines.length > 0, '前置：应有引擎');

    // 站点已选、桥接已开——此时仍为 manual 的，就是能力层面走不通的引擎
    const rows = engineReachability(engines, {
      imagehost: { enabled: true, provider: 'catbox' },
      engineModes: DEFAULT_MODES,
    });
    for (const r of rows) {
      const src = engines.find((e) => e.id === r.id);
      const bridgeUnavailable = src?.availability?.bridge === 'unavailable';
      if (bridgeUnavailable) {
        assert.equal(r.path, 'manual', `${r.id} 的 bridge 标注为 unavailable，UI 必须告知需手动`);
        assert.match(r.label, /需手动/);
      } else {
        assert.notEqual(r.path, 'manual', `${r.id} 的 bridge 未标 unavailable，不应被判死为手动`);
      }
    }

    // 反向钉死：只要后端给 Lens 标了 bridge=unavailable，UI 就必须说手动。
    // 若后端哪天修好了 Lens，这条会红——那正是我们希望被提醒的时刻。
    const lens = engines.find((e) => e.id === 'google_lens');
    if (lens?.availability?.bridge === 'unavailable') {
      assert.equal(pathOf('google_lens', { imagehost: { enabled: true, provider: 'catbox' }, engineModes: DEFAULT_MODES }).label, '需手动跑腿');
    }
  });
});

describe('渲染路径可执行性（DOM 桩，非视觉验证）', () => {
  test('E12：可达性行能真正渲染出来，文案与引擎一一对应', () => {
    const uninstall = installDomStub();
    try {
      const node = engineReachRows(ENGINES, {
        imagehost: { enabled: true, provider: 'catbox' },
        engineModes: DEFAULT_MODES,
      });
      assert.ok(node, '有启用引擎时应产出行容器');

      const rows = stubFindAll(node, 'consent-row--sub');
      assert.equal(rows.length, 3, '三个启用引擎各一行');

      const text = stubText(node);
      assert.match(text, /Google Lens|Lens/, `应出现 Lens 名称，实际：${text}`);
      assert.match(text, /需手动跑腿/, `Lens 行必须写明需手动，实际：${text}`);
      assert.match(text, /可自动（图床桥接）/, `Bing 行应为桥接可达，实际：${text}`);
      assert.match(text, /勾选下方/, '应带一句可达性说明，否则用户看不懂这几行是什么');
    } finally {
      uninstall();
    }
  });

  test('E13：没有启用引擎时不渲染任何行（也不抛错）', () => {
    const uninstall = installDomStub();
    try {
      assert.equal(engineReachRows([], { imagehost: { enabled: true, provider: 'catbox' } }), null);
      assert.equal(engineReachRows(null, {}), null);
    } finally {
      uninstall();
    }
  });
});

describe('接线完整性（防漏传）', () => {
  test('E10：consentModal 必须把 imagehost / engineModes / publicUrl 三个入参都传给可达性判定', () => {
    // 曾发生「弹窗授权站点被执行层无视」——根因就是某一层参数没往下传。
    // 这里在源码级钉死调用形状，避免同类漏传再次无声发生。
    const src = fs.readFileSync(path.join(REPO_ROOT, 'public/assets/views/shared.view.js'), 'utf8');
    assert.match(src, /engineReachRows\(engines,\s*\{\s*imagehost,\s*engineModes,\s*publicUrl\s*\}\)/,
      'consentModal 调用 engineReachRows 时必须传齐三个参数');
    assert.match(src, /export function consentModal\(\{\s*task,\s*engines,\s*imagehost,\s*engineModes = \{\},\s*publicUrl = null,\s*onConfirm,\s*\}\)/,
      'consentModal 签名必须接收 engineModes 与 publicUrl');
  });

  test('E11：任务详情页必须把真实 task 传给确认流程（否则 source_type 无从判断）', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'public/assets/views/task-detail.view.js'), 'utf8');
    assert.match(src, /runAnalysesFlow\(\{\s*taskId: id,\s*task: state\.task,/,
      'task-detail 必须把 state.task 传下去，UI 才能判断深链是否可达');
  });
});
