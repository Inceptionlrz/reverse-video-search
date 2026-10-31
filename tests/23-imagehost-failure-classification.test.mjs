// 图床失败时的降级结论必须与「引擎失败」区分开。
//
// 起因（GitHub 图床不可达时实跑 2 帧 × 3 引擎，6 个作业全 manual）：
//   · yandex / bing 末级 = NETWORK_ERROR「GitHub 上传失败…」
//     —— 图床传不上去，却被报成引擎网络异常，照着去查引擎连通性就是查错方向；
//   · google_lens 末级 = ENGINE_NO_HTTP_RESULT，但末条日志写着「GitHub 上传失败」
//     —— 结论与日志对不上，因为图床失败压根没进 lastError，末级落到了兜底码。
//
// 契约：结论的**主因**要正确，且图床情况必须被写出来（决定有没有可复制的直链）。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ERROR_CODES, isRetryableErrorCode } from '../server/lib/errors.mjs';
import { ERROR_COPY, errorText } from '../public/assets/format.js';
import { classifyManualOutcome } from '../server/services/analysis-execute.mjs';
import { createGoogleLensProvider } from '../server/providers/google-lens.mjs';
import { createBingProvider } from '../server/providers/bing.mjs';
import { createYandexProvider } from '../server/providers/yandex.mjs';

const HOST_FAIL = {
  ok: false,
  errorCode: 'NETWORK_ERROR',
  errorMessage: 'GitHub 上传失败：Client network socket disconnected before secure TLS connection was established',
};

const ENGINE_FAIL = { ok: false, errorCode: 'TIMEOUT', errorMessage: '引擎请求超时' };

describe('图床失败必须有自己的错误码，不能伪装成引擎网络错误', () => {
  test('C1：错误码已在服务端与界面两侧字典登记，不会回退成"未知原因"', () => {
    assert.ok('IMAGEHOST_UPLOAD_FAILED' in ERROR_CODES, '服务端字典要有这个码');
    assert.ok('IMAGEHOST_UPLOAD_FAILED' in ERROR_COPY, '界面字典要有对应文案');
    assert.notEqual(errorText('IMAGEHOST_UPLOAD_FAILED'), '未知原因');
    assert.match(errorText('IMAGEHOST_UPLOAD_FAILED'), /图床/);
  });

  test('C2：文案要指向图床而不是网络，避免与 NETWORK_ERROR 混淆', () => {
    assert.notEqual(errorText('IMAGEHOST_UPLOAD_FAILED'), errorText('NETWORK_ERROR'));
    assert.doesNotMatch(errorText('IMAGEHOST_UPLOAD_FAILED'), /^网络/);
  });

  test('C3：可重试——图床失败多为网络抖动或限流，不是终局结论', () => {
    assert.equal(isRetryableErrorCode('IMAGEHOST_UPLOAD_FAILED'), true);
  });
});

describe('主因判定：自动路径可用的引擎，图床失败就是主因', () => {
  test('B1：Bing（bridge 已验证）图床失败 -> IMAGEHOST_UPLOAD_FAILED', () => {
    const p = createBingProvider();
    assert.equal(p.availability.bridge, 'verified', '前置：Bing 桥接必须是已验证，否则本例不适用');
    const out = classifyManualOutcome({ engineError: null, imagehostError: HOST_FAIL, provider: p });
    assert.equal(out.code, 'IMAGEHOST_UPLOAD_FAILED');
    assert.match(out.message, /图床上传失败/);
  });

  test('B2：Yandex（bridge 仅未验证，非不可用）图床失败 -> 同样是图床主因', () => {
    const p = createYandexProvider();
    assert.notEqual(p.availability.bridge, 'unavailable', '前置：Yandex 桥接非不可用');
    const out = classifyManualOutcome({ engineError: null, imagehostError: HOST_FAIL, provider: p });
    assert.equal(out.code, 'IMAGEHOST_UPLOAD_FAILED');
  });
});

describe('主因判定：自动路径实测不可用的引擎，引擎才是主因', () => {
  test('G1：Google（deeplink 与 bridge 都不可用）图床失败 -> 结论仍是 ENGINE_NO_HTTP_RESULT', () => {
    const p = createGoogleLensProvider();
    assert.equal(p.availability.bridge, 'unavailable', '前置：Google 桥接必须是不可用');
    const out = classifyManualOutcome({ engineError: null, imagehostError: HOST_FAIL, provider: p });
    // 曾落到 IMAGEHOST_UPLOAD_FAILED：会让人以为修好图床 Google 就能自动出结果，
    // 而实测是 HTTP 层根本取不到，图床修好也一样。
    assert.equal(out.code, 'ENGINE_NO_HTTP_RESULT');
  });

  test('G2：但图床失败必须写进文案——它决定了有没有可复制的直链', () => {
    const out = classifyManualOutcome({
      engineError: null, imagehostError: HOST_FAIL, provider: createGoogleLensProvider(),
    });
    assert.match(out.message, /图床上传失败/);
    assert.match(out.message, /没有可复制的图片直链/);
  });

  test('G3：图床正常时不再提图床，只给引擎结论', () => {
    const out = classifyManualOutcome({
      engineError: null, imagehostError: null, provider: createGoogleLensProvider(),
    });
    assert.equal(out.code, 'ENGINE_NO_HTTP_RESULT');
    assert.doesNotMatch(out.message, /图床/);
  });
});

describe('引擎已给出实测结论时，引擎码优先', () => {
  test('E1：引擎错误 + 图床失败 -> 保留引擎码，并补充图床情况', () => {
    const out = classifyManualOutcome({
      engineError: ENGINE_FAIL, imagehostError: HOST_FAIL, provider: createBingProvider(),
    });
    assert.equal(out.code, 'TIMEOUT', '主因是引擎超时，不能被图床覆盖');
    assert.match(out.message, /引擎请求超时/);
    assert.match(out.message, /图床上传失败/);
  });

  test('E2：只有引擎错误 -> 不凭空提图床', () => {
    const out = classifyManualOutcome({
      engineError: ENGINE_FAIL, imagehostError: null, provider: createBingProvider(),
    });
    assert.equal(out.code, 'TIMEOUT');
    assert.doesNotMatch(out.message, /图床/);
  });
});

describe('变异自检：断言必须真能抓住 bug', () => {
  test('M1：若把判据改成"是否有手动深链"，Yandex 会被误判为引擎不可用', () => {
    // 这条证明 B2 的判据不是凑出来的：Yandex 和 Google 都有 buildManualDeeplink，
    // 所以不能用它当判据，必须用 availability。
    const y = createYandexProvider();
    const g = createGoogleLensProvider();
    const yHas = typeof y.buildManualDeeplink === 'function' && Boolean(y.buildManualDeeplink('https://e.invalid/a.jpg'));
    const gHas = typeof g.buildManualDeeplink === 'function' && Boolean(g.buildManualDeeplink('https://e.invalid/a.jpg'));
    assert.equal(yHas, gHas, '前置：两者都有手动深链，故该判据无法区分二者');
    assert.equal(y.availability.bridge !== 'unavailable', true, '只有 availability 能区分');
  });

  test('M2：若把 (c) 分支删掉只留兜底，Bing 会被误报成"引擎取不到"', () => {
    const wrong = classifyManualOutcome({ engineError: null, imagehostError: null, provider: createBingProvider() });
    // 图床失败被吞掉时就会退化成这个结果——正是修复前的表现
    assert.equal(wrong.code, 'ENGINE_NO_HTTP_RESULT');
    const right = classifyManualOutcome({ engineError: null, imagehostError: HOST_FAIL, provider: createBingProvider() });
    assert.notEqual(right.code, wrong.code, '两分支结果必须不同，否则测试抓不到回归');
  });
});
