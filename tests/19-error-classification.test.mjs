// 降级原因的分类与文案契约。
//
// 起因（用户实测反馈）：任务跑完 36 个组合全部降级为手动，横幅却写着
// 「页面结构无法解析、未知原因、网络不可达」：
//   - "页面结构无法解析" 实际是图床返回 412（拒绝上传），跟解析毫无关系；
//   - "未知原因" 实际是 PROXY_UNREACHABLE，因为这个码根本不在文案字典里，
//     被 errorText 回退掉了。
// 两个都是"分类/文案错"，但它们直接决定了用户往哪个方向排障——
// 分类错了，用户会去查 HTML 解析，而真正该查的是图床与代理。
// 本文件把分类与文案钉死，避免再退化成误导性措辞。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { statusToCode } from '../server/lib/http/request.mjs';
import { ERROR_CODES } from '../server/lib/errors.mjs';
import { ERROR_COPY, errorText } from '../public/assets/format.js';
import { classifyImageUrl } from '../server/providers/imagehost/base.mjs';

describe('HTTP 状态 → 错误码分类', () => {
  test('C1：412 必须归为 UPLOAD_REJECTED，不能落进 PARSE_ERROR', () => {
    // catbox.moe 匿名上传实测返回 412 Invalid uploader。落到 PARSE_ERROR 时
    // 界面写"页面结构无法解析"，把"图床拒收"说成"解析失败"，排障方向被带偏。
    assert.equal(statusToCode(412, 'Invalid uploader'), 'UPLOAD_REJECTED');
  });

  test('C2：其余拒绝类状态各自归位', () => {
    assert.equal(statusToCode(400, ''), 'UPLOAD_REJECTED');
    assert.equal(statusToCode(413, ''), 'UPLOAD_REJECTED');
    assert.equal(statusToCode(415, ''), 'UPLOAD_REJECTED');
    assert.equal(statusToCode(429, ''), 'RATE_LIMITED');
    assert.equal(statusToCode(401, ''), 'FORBIDDEN');
    assert.equal(statusToCode(403, ''), 'FORBIDDEN');
    assert.equal(statusToCode(500, ''), 'NETWORK_ERROR');
    assert.equal(statusToCode(503, ''), 'NETWORK_ERROR');
  });

  test('C3：UPLOAD_REJECTED 不可重试——改分类后不应带来空转重试', async () => {
    const { isRetryableErrorCode } = await import('../server/lib/errors.mjs');
    assert.equal(isRetryableErrorCode('UPLOAD_REJECTED'), false, '被拒的上传不该重试');
    assert.equal(isRetryableErrorCode('PARSE_ERROR'), true, '解析错误仍可重试（对照组）');
  });
});

describe('错误码 → 中文文案（不得有缺口）', () => {
  test('T1：服务端错误码字典里的每一项都有人话文案', () => {
    // PROXY_UNREACHABLE 曾漏在 ERROR_COPY 之外，errorText 回退成"未知原因"，
    // 用户看到的降级理由就成了"未知原因"。缺文案比报错更误导。
    // ZERO_RESULT 例外：errors.mjs 明确它是"成功零命中，不视为错误"，
    // 永远不会作为降级原因出现，界面另有零命中文案。
    const missing = Object.keys(ERROR_CODES)
      .filter((code) => code !== 'ZERO_RESULT')
      .filter((code) => !(code in ERROR_COPY));
    assert.deepEqual(missing, [], `以下错误码缺少中文文案，界面会显示成"未知原因"：${missing.join(', ')}`);
  });

  test('T2：执行层实际会写出的码也必须有文案', () => {
    // 这几个不一定都在 ERROR_CODES 里，但会落进 analyses.error_code 显示在界面上。
    const emitted = ['PROXY_UNREACHABLE', 'PROVIDER_DISABLED', 'UPLOAD_REJECTED', 'PARSE_ERROR',
      'NETWORK_ERROR', 'TIMEOUT', 'CAPTCHA', 'RATE_LIMITED', 'FORBIDDEN'];
    const missing = emitted.filter((code) => !(code in ERROR_COPY));
    assert.deepEqual(missing, [], `执行层会写出但界面没有文案：${missing.join(', ')}`);
  });

  test('T2b：文案键名必须与服务端发出的码逐字一致', () => {
    // 曾写成 RATE_LIMIT 而服务端发 RATE_LIMITED，限流因此一直显示"未知原因"。
    // 拼错键名不会报错，只会静默回退——这类缺口只能靠这条断言拦住。
    assert.ok('RATE_LIMITED' in ERROR_COPY, '服务端发 RATE_LIMITED，字典键名必须逐字一致');
    assert.ok(!('RATE_LIMIT' in ERROR_COPY), '不得再保留拼错的 RATE_LIMIT 键');
  });

  test('T3：文案不得回退成占位符', () => {
    assert.notEqual(errorText('PROXY_UNREACHABLE'), '未知原因');
    assert.notEqual(errorText('FORBIDDEN'), '未知原因');
    assert.equal(errorText('NO_SUCH_CODE_XYZ'), '未知原因', '真正未知的码仍回退');
  });
});

describe('图床桥接：拿到链接不等于可用', () => {
  // 实测（2026-10-30）：tmpfiles.org 上传 HTTP 200、链接 https://tmpfiles.org/<id>/frame.jpg，
  // 但 content-type 是 text/html（3KB 预览页），/dl/<id> 还 404。
  // 放行这种链接，引擎就是拿一个网页去以图搜图——36 个组合跑完全是空结果，
  // 而上层只看到"上传成功"，失败被推迟成莫名的"页面结构无法解析"。
  test('B1：content-type 不是 image/* 时判失败，并说清是"不是图片本体"', () => {
    const v = classifyImageUrl({ ok: true, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    assert.equal(v.ok, false);
    assert.match(v.reason, /不是图片本体/);
    assert.match(v.reason, /text\/html/);
  });

  test('B2：真图片链接放行', () => {
    for (const ct of ['image/jpeg', 'image/png', 'image/webp', 'IMAGE/JPEG']) {
      const v = classifyImageUrl({ ok: true, status: 200, headers: { 'content-type': ct } });
      assert.equal(v.ok, true, `${ct} 应被接受`);
    }
  });

  test('B3：取不回链接也算失败，措辞不能诬赖图床', () => {
    const net = classifyImageUrl({ ok: false, status: 0, errorMessage: 'TLS 握手超时' });
    assert.equal(net.ok, false);
    assert.match(net.reason, /无法取回/);
    assert.match(net.reason, /TLS 握手超时/);
    assert.doesNotMatch(net.reason, /拒绝|坏了/, '本地网络抖动也会走到这里，不能说成图床坏了');
  });

  test('B4：完全没有 content-type 时不得放行', () => {
    const v = classifyImageUrl({ ok: true, status: 200, headers: {} });
    assert.equal(v.ok, false);
    assert.match(v.reason, /未知|不是图片本体/);
  });
});
