// 日志脱敏回归（SPEC §14 验收项 8：第三方密钥不写入日志与导出）。
//
// 现状：系统当前不持有任何第三方凭据——图床为匿名上传（0x0/catbox/tmpfiles），
// 三家引擎走深链或手工，无 API Key。因此本用例守的是「纵深防线」本身：
// 一旦将来接入带密钥的服务，凭据必须被拦下。
//
// 已知残余缺口（不在本用例断言范围内，留档）：数组的**裸**字符串元素不做形态
// 匹配（redactValue 对数组只逐元素递归，裸串无键名可判）。要堵需引入值形态
// 启发式，会带来误伤，故暂不处理——当前无凭据可泄，风险为 0。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { redactText, redactValue } from '../server/lib/logger.mjs';

const SECRET = 'sk-LIVE-SECRET-abcdef123456';

describe('日志脱敏（EARS #29 / SPEC 验收项 8）', () => {
  test('R1：敏感键名的值一律替换为 [redacted]（含嵌套对象）', () => {
    const out = redactValue({
      apiKey: SECRET,
      authorization: `Bearer ${SECRET}`,
      nested: { token: SECRET, url: 'https://img.example.com/a.jpg' },
    });
    assert.equal(out.apiKey, '[redacted]');
    assert.equal(out.authorization, '[redacted]');
    assert.equal(out.nested.token, '[redacted]');
    assert.equal(out.nested.url, 'https://img.example.com/a.jpg', '非敏感字段不得被误伤');
    assert.doesNotMatch(JSON.stringify(out), new RegExp(SECRET), '脱敏后不得残留密钥原文');
  });

  test('R2：URL 中的 userinfo 凭据被抹除', () => {
    assert.equal(redactText('http://user:hunter2@proxy.local:8080'), 'http://***@proxy.local:8080');
  });

  test('R3：正文里被整体回显的 Bearer 凭据被抹除', () => {
    const line = `GET /x failed: Authorization: Bearer ${SECRET}`;
    const out = redactText(line);
    assert.doesNotMatch(out, new RegExp(SECRET), 'Bearer 凭据不得残留');
    assert.match(out, /Bearer \[redacted\]/, '应替换为占位符');
  });

  test('R4：普通文本不受影响——脱敏不得破坏正常日志可读性', () => {
    const line = '抽帧完成：8 帧（interval），耗时 1.2s';
    assert.equal(redactText(line), line);
  });
});
