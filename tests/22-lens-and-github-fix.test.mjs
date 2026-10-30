// 本轮两处修复的契约：Google 的错误分类 / 手动深链，与 GitHub 图床的同名冲突。
//
// 起因（用户实跑「9月23日_成品.mp4」，36 个作业）：
//   google_lens 12/12 全 manual，error_code=PARSE_ERROR；
//   bing 7/12 失败，原因「GitHub 上传失败：引擎返回 HTTP 422」。
// 前者是**错误分类误导**（不是解析问题），后者是**真 bug**（同名覆盖缺 sha）。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ERROR_CODES, isRetryableErrorCode } from '../server/lib/errors.mjs';
import { ERROR_COPY, errorText } from '../public/assets/format.js';
import { createGoogleLensProvider } from '../server/providers/google-lens.mjs';
import { createBingProvider } from '../server/providers/bing.mjs';
import { createYandexProvider } from '../server/providers/yandex.mjs';
import { createGitHubHost, githubMessage } from '../server/providers/imagehost/github.mjs';

describe('Google：失败码必须说清是"取不到"而不是"解析不了"', () => {
  test('L1：Lens 的降级码是 ENGINE_NO_HTTP_RESULT，不是 PARSE_ERROR', async () => {
    // 曾报 PARSE_ERROR，界面写「页面结构无法解析」——
    // 会让人去改解析规则，而真实原因是结果页由浏览器 JS 渲染、HTTP 层没有数据。
    const res = await createGoogleLensProvider().searchByDeeplink({}, 'https://img.test/a.jpg');
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'ENGINE_NO_HTTP_RESULT');
    assert.notEqual(res.errorCode, 'PARSE_ERROR');
  });

  test('L2：该码在界面字典里有中文文案，不会回退成"未知原因"', () => {
    assert.ok('ENGINE_NO_HTTP_RESULT' in ERROR_CODES, '服务端字典要有这个码');
    assert.ok('ENGINE_NO_HTTP_RESULT' in ERROR_COPY, '界面字典要有对应文案');
    assert.notEqual(errorText('ENGINE_NO_HTTP_RESULT'), '未知原因');
    assert.match(errorText('ENGINE_NO_HTTP_RESULT'), /浏览器/);
  });

  test('L3：不可重试——HTTP 层取不到就是取不到，重试只是空转', () => {
    assert.equal(isRetryableErrorCode('ENGINE_NO_HTTP_RESULT'), false);
  });

  test('L4：结论文案要写明实测证据，不能只说"不可用"', () => {
    const notes = createGoogleLensProvider().notes;
    assert.match(notes, /JS/, '应说明是 JS 渲染导致');
    assert.match(notes, /sorry|风控/, '应说明浏览器直开还会撞 Google 风控');
    assert.match(notes, /scripts\/probe\//, '应给出可复跑的探针路径');
  });
});

describe('手动深链：省掉手动上传文件这一步', () => {
  test('M1：Lens 能生成"已带图片"的链接', () => {
    const url = createGoogleLensProvider().buildManualDeeplink('https://img.test/a.jpg');
    assert.match(url, /^https:\/\/lens\.google\.com\/uploadbyurl\?url=/);
    assert.match(url, /url=https%3A%2F%2Fimg\.test%2Fa\.jpg/, '图片 URL 必须被编码进 url 参数');
  });

  test('M2：没有公网 URL 时返回 null（回落到普通上传页）', () => {
    assert.equal(createGoogleLensProvider().buildManualDeeplink(null), null);
    assert.equal(createGoogleLensProvider().buildManualDeeplink(''), null);
  });

  test('M3：实测能自动解析的引擎不需要手动深链', () => {
    // Bing 是唯一实测跑通的自动引擎；给它加手动深链说明分类错了（把能自动的说成不能）。
    assert.equal(createBingProvider().buildManualDeeplink('https://img.test/a.jpg'), null);
  });

  test('M3b：Yandex 同样 HTTP 取不到，也该给带图链接', () => {
    // 实测（2026-10-30，12 帧任务）：Yandex 桥接上传成功、深链 200，
    // 但服务端 HTML 无结果结构（客户端渲染），12/12 全落 manual。
    // 与 Google 同一类问题，处理也该一致——否则用户要为它再手动传一次文件。
    const url = createYandexProvider().buildManualDeeplink('https://img.test/a.jpg');
    assert.match(url, /^https:\/\/yandex\.com\/images\/search\?rpt=imageview&url=/);
    assert.match(url, /url=https%3A%2F%2Fimg\.test%2Fa\.jpg/);
    assert.equal(createYandexProvider().buildManualDeeplink(null), null);
  });

  test('M4：Lens 的自动深链仍必须为空，不得被手动深链顶替', () => {
    // 编排层靠 buildDeeplink()===null 跳过 deeplink 与 bridge 两级自动尝试。
    assert.equal(createGoogleLensProvider().buildDeeplink('https://img.test/a.jpg'), null);
  });
});

describe('GitHub 图床：同名覆盖必须补 sha', () => {
  test('G1：错误描述要从响应体里取，不能只报 HTTP 状态', () => {
    // 实测第二次 PUT 返回 422，响应体 {"message":"Invalid request.\n\n\"sha\" wasn't supplied."}
    // 只报"HTTP 422"完全无法排障；只取首行也一样（首行是 "Invalid request."）。
    const res = {
      ok: false, status: 422, errorMessage: '引擎返回 HTTP 422',
      body: JSON.stringify({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }),
    };
    const msg = githubMessage(res);
    assert.match(msg, /sha/, '必须带上 GitHub 说的真正原因');
    assert.match(msg, /supplied/);
  });

  test('G2：非 JSON 响应时回落到传输层描述，不抛异常', () => {
    assert.equal(githubMessage({ status: 502, errorMessage: '网络不可达', body: '<html>代理错误</html>' }), '网络不可达');
    assert.equal(githubMessage({ status: 0, errorMessage: null, body: '' }), '无响应');
    assert.equal(githubMessage(null), '无响应');
  });

  test('G3：同名第二次上传要先取 sha 再覆盖，而不是直接失败', async () => {
    // 同一帧会被多个引擎各上传一次、路径相同，第二个起必撞 422/409。
    // 实测 12 帧任务里 7 帧因此失败。
    const host = createGitHubHost();
    host.token = 't';
    host.repo = 'o/r';
    const calls = [];
    const transport = async (url, options) => {
      calls.push(`${options.method} ${url}`);
      if (options.method === 'PUT') {
        const hasSha = JSON.parse(options.body).sha;
        return hasSha
          ? { ok: true, status: 200, headers: {}, body: JSON.stringify({ content: { download_url: 'https://raw.test/x.jpg' } }), latencyMs: 1, errorCode: null, errorMessage: null }
          : { ok: false, status: 422, headers: {}, body: JSON.stringify({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }), latencyMs: 1, errorCode: 'PARSE_ERROR', errorMessage: '引擎返回 HTTP 422' };
      }
      if (options.method === 'GET') {
        return { ok: true, status: 200, headers: {}, body: JSON.stringify({ sha: 'abc123' }), latencyMs: 1, errorCode: null, errorMessage: null };
      }
      throw new Error(`未预期的方法 ${options.method}`);
    };
    // 直链校验也走 transport：返回 image/* 才算真图片
    const ctx = {
      cfg: { proxy: '', net: {} },
      metrics: { imagehostRequests: {} },
      transport: async (url, options) => {
        if (url.startsWith('https://raw.')) {
          return { ok: true, status: 200, headers: { 'content-type': 'image/jpeg' }, body: '', latencyMs: 1, errorCode: null, errorMessage: null };
        }
        return transport(url, options);
      },
    };
    const up = await host.upload(ctx, { buffer: Buffer.from('x'), filename: 'f.jpg' });
    assert.equal(up.ok, true, '补 sha 后应覆盖成功，而不是报 422');
    assert.ok(calls.some((c) => c.startsWith('GET') && c.includes('ref=frames')), '取 sha 必须带 ref=分支，否则读到默认分支拿不到');
    assert.ok(calls.some((c) => c.startsWith('PUT')), '至少两次 PUT（首次冲突 + 带 sha 重试）');
  });

  test('G4：取不到 sha 时如实失败，并把 GitHub 的原因带上', async () => {
    const host = createGitHubHost();
    host.token = 't';
    host.repo = 'o/r';
    const ctx = {
      cfg: { proxy: '', net: {} },
      transport: async (url, options) => {
        if (options.method === 'GET') return { ok: false, status: 404, headers: {}, body: '', latencyMs: 1, errorCode: 'PARSE_ERROR', errorMessage: '引擎返回 HTTP 404' };
        return { ok: false, status: 422, headers: {}, body: JSON.stringify({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }), latencyMs: 1, errorCode: 'PARSE_ERROR', errorMessage: '引擎返回 HTTP 422' };
      },
    };
    const up = await host.upload(ctx, { buffer: Buffer.from('x'), filename: 'f.jpg' });
    assert.equal(up.ok, false);
    assert.match(up.errorMessage, /sha/, '失败原因必须含 GitHub 说的 sha 缺失');
    assert.doesNotMatch(up.errorMessage, /^GitHub 上传失败：引擎返回 HTTP 422$/, '不能只报裸状态码');
  });
});
