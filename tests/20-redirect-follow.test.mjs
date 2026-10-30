// 深链 3xx 跟随契约。
//
// 起因（用户实测反馈"一直都是手动上传"）：Bing 深链返回 302，而 request.mjs 不自动跟随
// 3xx、且 3xx 不是 res.ok。旧实现把 `if (!res.ok) return` 写在跟随分支之前，
// 于是 302 在第一跳就被判失败返回——后面整段跟随代码是永不执行的死代码。
// 界面上表现为"页面结构无法解析"，真正原因却是"压根没跟到结果页"。
//
// 本文件用注入式 transport（ctx.transport）在不发真实网络请求的前提下把这些分支钉死：
// request.mjs 固定走 https.request，本地 http 服务打不到它；不注入就只能写
// "源码里有没有这行"的假断言，回归价值为零。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BaseProvider, MAX_REDIRECT_HOPS } from '../server/providers/base.mjs';
import { statusToCode, resolveTimeouts } from '../server/lib/http/request.mjs';
import { loadConfig } from '../server/lib/config.mjs';
import { createBingProvider } from '../server/providers/bing.mjs';

// 按调用次序回放脚本，模拟 request() 的返回形态（含 statusToCode 归类）。
function makeTransport(script) {
  const seen = [];
  const transport = (url) => {
    const i = seen.length;
    seen.push(url);
    const step = script[i] ?? script[script.length - 1];
    const ok = step.status >= 200 && step.status < 300;
    return {
      ok,
      status: step.status,
      headers: step.location ? { location: step.location } : {},
      body: step.body ?? '',
      latencyMs: 1,
      errorCode: ok ? null : statusToCode(step.status, step.body ?? ''),
      errorMessage: ok ? null : `引擎返回 HTTP ${step.status}`,
    };
  };
  return { transport, seen };
}

class ScriptedProvider extends BaseProvider {
  constructor(startUrl) {
    super({ id: 'scripted', label: '脚本引擎', entryUrl: 'https://example.test/', availability: {} });
    this.startUrl = startUrl;
  }

  buildDeeplink() {
    return this.startUrl;
  }

  parse(html) {
    // 命中标记为 HIT 的响应体即视为解析到一条结果。
    return /HIT/.test(String(html || '')) ? [{ url: 'https://example.test/result', title: '结果' }] : [];
  }
}

const START = 'https://engine.test/start';
const HOP1 = 'https://engine.test/hop1';
const HOP2 = 'https://engine.test/hop2';
const FINAL = 'https://engine.test/final';

describe('深链 3xx 跟随', () => {
  test('R1：302→301→302→200 链式跟随，结果取自最终页', async () => {
    // Bing detailv2 实测就是这个跳数（302→301→302→200）。
    const { transport, seen } = makeTransport([
      { status: 302, location: HOP1 },
      { status: 301, location: HOP2 },
      { status: 302, location: FINAL },
      { status: 200, body: 'HIT' },
    ]);
    const p = new ScriptedProvider(START);
    const res = await p.searchByDeeplink({ transport }, 'https://img.test/a.jpg');

    assert.equal(res.ok, true, '链式跳完后必须成功拿到结果');
    assert.equal(res.items.length, 1);
    assert.equal(res.requestUrl, FINAL, 'requestUrl 应是结果页而非起始深链');
    assert.deepEqual(seen, [START, HOP1, HOP2, FINAL]);
  });

  test('R2：跳数超过上限时如实报错，不静默成功', async () => {
    const script = [];
    for (let i = 0; i < MAX_REDIRECT_HOPS + 2; i += 1) script.push({ status: 302, location: `https://engine.test/r${i}` });
    script.push({ status: 200, body: 'HIT' });
    const { transport } = makeTransport(script);
    const p = new ScriptedProvider(START);
    const res = await p.searchByDeeplink({ transport }, 'https://img.test/a.jpg');

    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'PARSE_ERROR');
    assert.match(res.errorMessage, /重定向次数超过限制/);
    assert.match(res.errorMessage, new RegExp(`${MAX_REDIRECT_HOPS} 跳`));
  });

  test('R3：不重定向时行为不变（防跟随逻辑误伤正常路径）', async () => {
    const { transport, seen } = makeTransport([{ status: 200, body: 'HIT' }]);
    const p = new ScriptedProvider(START);
    const res = await p.searchByDeeplink({ transport }, 'https://img.test/a.jpg');
    assert.equal(res.ok, true);
    assert.equal(res.requestUrl, START);
    assert.equal(seen.length, 1);
  });

  test('R4：跟随到 500 时报 NETWORK_ERROR，而不是卡在第一跳的 302', async () => {
    const { transport, seen } = makeTransport([
      { status: 302, location: HOP1 },
      { status: 500, body: 'boom' },
    ]);
    const p = new ScriptedProvider(START);
    const res = await p.searchByDeeplink({ transport }, 'https://img.test/a.jpg');

    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'NETWORK_ERROR', '终态 500 应归 NETWORK_ERROR');
    assert.equal(res.httpStatus, 500, '报的是终态状态码，不是第一跳的 302');
    assert.equal(seen.length, 2, '必须真的跟了一跳');
  });

  test('R5：3xx 但无 Location 时按失败返回，不空转', async () => {
    const { transport, seen } = makeTransport([{ status: 302 }]);
    const p = new ScriptedProvider(START);
    const res = await p.searchByDeeplink({ transport }, 'https://img.test/a.jpg');
    assert.equal(res.ok, false);
    assert.equal(seen.length, 1, '没有 Location 就不该继续请求');
  });

  test('R6：注入 transport 不影响出站计数', async () => {
    const { transport } = makeTransport([{ status: 200, body: 'HIT' }]);
    const metrics = { providerRequests: {}, imagehostRequests: {} };
    const p = new ScriptedProvider(START);
    const ctx = { transport, metrics, providerId: 'scripted' };
    await p.searchByDeeplink(ctx, 'https://img.test/a.jpg');
    assert.equal(metrics.providerRequests.scripted, 1, '计数与是否走真实网络无关');
  });
});

describe('深链形态', () => {
  test('B1：Bing 深链必须是实测可达的 detailv2 形态', () => {
    // 旧形态 images/searchbyimage/upload?imgurl=&cbir=sbi 跟随到 cn.bing.com 是 404（实测），
    // 换成 detailv2 后 302→301→302→200 且 iusc 结果项 35 个（scripts/probe/out-21-B1-detailv2.html）。
    const url = createBingProvider().buildDeeplink('https://img.test/a.jpg');
    assert.match(url, /^https:\/\/www\.bing\.com\/images\/search\?/);
    assert.match(url, /view=detailv2/);
    assert.match(url, /q=imgurl:https%3A%2F%2Fimg\.test%2Fa\.jpg/, '图片 URL 必须被编码进 q=imgurl:');
    assert.doesNotMatch(url, /searchbyimage\/upload/, '旧形态跟随后 404，不得回退');
  });

  test('B2：深链不可用（buildDeeplink 返回 null）时不发请求', async () => {
    let calls = 0;
    const transport = () => {
      calls += 1;
      return { ok: true, status: 200, headers: {}, body: 'HIT', latencyMs: 1, errorCode: null, errorMessage: null };
    };
    class NoDeeplink extends ScriptedProvider {
      buildDeeplink() {
        return null;
      }
    }
    const res = await new NoDeeplink(START).searchByDeeplink({ transport }, 'https://img.test/a.jpg');
    assert.equal(res.ok, false);
    assert.equal(calls, 0, '形态不可用就不该有任何出站请求');
  });
});

describe('超时配置必须真正生效（不能只改 config.mjs 就以为改了）', () => {
  test('T1：cfg.net 下的超时要被 request 读到', () => {
    // 曾经：config.mjs 存 cfg.net.connectTimeoutMs，request 读 cfg.connectTimeoutMs，
    // 于是把预算从 1s 放宽到 3s 之后，实际走的还是 1s——配置被静默无视，
    // 表现为"代理其实只是慢，却被判 PROXY_UNREACHABLE"。
    const cfg = loadConfig({});
    const t = resolveTimeouts(cfg, {});
    assert.equal(t.connect, cfg.net.connectTimeoutMs);
    assert.equal(t.tls, cfg.net.tlsTimeoutMs);
    assert.equal(t.ttfb, cfg.net.ttfbTimeoutMs);
    assert.equal(t.total, cfg.net.totalTimeoutMs);
  });

  test('T2：env 覆盖同样要生效', () => {
    const cfg = loadConfig({ RVS_NET_TOTAL_TIMEOUT_MS: '45000' });
    assert.equal(resolveTimeouts(cfg, {}).total, 45000);
  });

  test('T3：平铺 cfg（探针脚本与旧调用方）仍然兼容', () => {
    const t = resolveTimeouts({ connectTimeoutMs: 900, totalTimeoutMs: 9000 }, {});
    assert.equal(t.connect, 900);
    assert.equal(t.total, 9000);
  });

  test('T4：显式 options 优先级最高', () => {
    const cfg = loadConfig({});
    assert.equal(resolveTimeouts(cfg, { ttfbTimeoutMs: 1234 }).ttfb, 1234);
  });

  test('T5：无配置时回落到内置默认', () => {
    const t = resolveTimeouts(undefined, {});
    assert.equal(t.connect, 1000);
    assert.equal(t.total, 15000);
  });
});

// 变异自检：把顺序换回旧写法（!res.ok 在前），同一份脚本必须失败。
// 若换回旧写法也能"通过"，说明 R1 根本没测到分支顺序，是永远绿的假断言。
describe('变异自检（证明上面的断言真的抓得住这个 bug）', () => {
  test('M1：旧顺序（先判 !res.ok）在 302 链上必然失败', async () => {
    async function buggySearch(ctx, startUrl) {
      let url = startUrl;
      for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
        const res = await ctx.transport(url);
        if (!res.ok) {
          return { ok: false, errorCode: res.errorCode, errorMessage: res.errorMessage, httpStatus: res.status };
        }
        const location = res.headers?.location;
        if (res.status >= 300 && res.status < 400 && location) {
          url = new URL(location, url).href;
          continue;
        }
        return { ok: true, requestUrl: url };
      }
      return { ok: false, errorCode: 'PARSE_ERROR', errorMessage: '重定向次数超过限制' };
    }

    const { transport } = makeTransport([
      { status: 302, location: HOP1 },
      { status: 301, location: HOP2 },
      { status: 302, location: FINAL },
      { status: 200, body: 'HIT' },
    ]);
    const res = await buggySearch({ transport }, START);

    assert.equal(res.ok, false, '旧写法必须在第一跳就失败——这正是线上 bug');
    assert.equal(res.httpStatus, 302, '旧写法卡在第一跳，报的是 302 而不是终态');

    // 对照：现实现在同一份脚本上是成功的（R1 已断言，这里只确认两者结论相反）。
    const { transport: t2 } = makeTransport([
      { status: 302, location: HOP1 },
      { status: 301, location: HOP2 },
      { status: 302, location: FINAL },
      { status: 200, body: 'HIT' },
    ]);
    const fixed = await new ScriptedProvider(START).searchByDeeplink({ transport: t2 }, 'https://img.test/a.jpg');
    assert.equal(fixed.ok, true);
  });
});
