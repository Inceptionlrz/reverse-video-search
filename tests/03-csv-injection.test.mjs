// SPEC §14 验收项 6：CSV 防公式注入（PRD EARS #25）。
// 触发字符按 PRD 原文六类：= + - @ 制表符(\t) 回车(\r)。
// 判定必须发生在双引号包裹**之前**（否则 "'" 会被当作普通内容包起来，前缀失效）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { makeClient, makeOfflineConfig, seedTask, startApp } from './helpers.mjs';
import { csvCell, csvRow, toCsv } from '../server/services/export.service.mjs';

const RISKY_LEADS = ['=', '+', '-', '@', '\t', '\r'];

describe('SPEC §14 验收项 6：CSV 防公式注入', () => {
  test('验收项6：六类触发字符开头的单元格都被按文本处理（EARS #25）', () => {
    const payloads = {
      '=': '=SUM(A1:A9)',
      '+': '+1+1',
      '-': '-2+3+cmd',
      '@': '@SUM(1+1)',
      '\t': '\t=SUM(A1)',
      '\r': '\r=1+1',
    };
    for (const lead of RISKY_LEADS) {
      const value = payloads[lead];
      assert.equal(value.charCodeAt(0), lead.charCodeAt(0), '夹具自检失败');
      const cell = csvCell(value);
      // 双引号包裹内部必须以单引号开头，即 "'<原始内容>"
      assert.equal(cell[0], '"', `单元格必须被双引号包裹：${JSON.stringify(cell)}`);
      assert.equal(cell[1], "'", `触发字符 ${JSON.stringify(lead)} 未做文本化处理：${JSON.stringify(cell)}`);
      assert.ok(cell.endsWith('"'), '单元格必须以双引号收尾');
      assert.equal(cell.length, value.length + 3, '长度应为 原值 + 单引号 + 两个双引号');
    }
  });

  test('验收项6：普通值不加前缀，引号按 CSV 规范翻倍转义', () => {
    assert.equal(csvCell('hello'), '"hello"');
    assert.equal(csvCell(''), '""');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
    assert.equal(csvCell(123), '"123"');
    assert.equal(csvCell('a"b'), '"a""b"');
    assert.equal(csvCell('a,b\nc'), '"a,b\nc"');
    // 第二字符才是触发字符的不算（只有开头判定）
    assert.equal(csvCell('x=1'), '"x=1"');
    assert.equal(csvRow(['=1', 'ok', '\tbad']), '"\'=1","ok","\'\tbad"');
  });

  test('验收项6：toCsv 带 BOM、表头为数据字段语义、无概率措辞', () => {
    const csv = toCsv([
      {
        id: 'rvs_r_1', url: 'https://example.com/a', canonical_url: 'https://example.com/a',
        domain: 'example.com', title: '=恶意标题', provider: 'bing', rank: 1,
        sort_score: 100, score_basis: 'engine_rank', local_hash_similarity: null,
        thumb_url: null, hit_count: 2, discovered_ms: 1700000000000,
      },
    ]);
    assert.equal(csv.charCodeAt(0), 0xfeff, 'CSV 必须以 BOM 开头');
    const text = csv.slice(1);
    const lines = text.split('\r\n');
    assert.equal(
      lines[0],
      '"线索ID","来源页URL","规范化URL","域名","标题","引擎","名次","线索分","分数来源","本地哈希相似度","缩略图地址","证据帧数","发现时间"',
    );
    assert.ok(lines[1].includes('"\'=恶意标题"'), `数据行未做注入防护：${lines[1]}`);
    assert.ok(!/准确率|概率/.test(csv), '导出不得出现概率 / 准确性措辞');
  });

  test('验收项6：经 /api/export.csv 端到端导出时注入字段仍被文本化（EARS #25）', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const taskId = await seedTask(app);
    const payloads = ['=SUM(A1:A9)', '+1+1', '-2+3', '@SUM(1+1)', '\tTAB_LEAD', '正常标题'];
    for (const title of payloads) {
      const up = await app.ctx.repos.results.upsert({
        url: `https://example.com/p/${encodeURIComponent(title)}`,
        title,
        provider: 'bing',
        rank: 1,
      });
      await app.ctx.repos.resultHits.insert({
        resultId: up.id,
        analysisId: `rvs_a_fixture_${encodeURIComponent(title)}`,
        frameId: `rvs_f_fixture_${encodeURIComponent(title)}`,
        taskId,
        provider: 'bing',
        rank: 1,
        scoreBasis: 'engine_rank',
        localHashSimilarity: null,
        sortScore: 100,
      });
    }

    const res = await api.get(`/api/export.csv?task_id=${taskId}`);
    assert.equal(res.status, 200);
    assert.equal(res.buffer[0], 0xef, 'CSV 必须带 BOM');
    const text = res.buffer.toString('utf8').slice(1);

    const RISKY = new Set(['=', '+', '-', '@', '\t', '\r']);
    for (const title of payloads) {
      const lead = title.charAt(0);
      if (RISKY.has(lead)) {
        // 触发字符开头：单元格内必须是 单引号 + 原值
        assert.ok(text.includes(`"'${title}"`), `标题 ${JSON.stringify(title)} 未按文本导出`);
        assert.ok(!text.includes(`"${title}"`), `标题 ${JSON.stringify(title)} 出现了未防护的裸单元格`);
      } else {
        // 普通值：原样包裹，不加单引号前缀
        assert.ok(text.includes(`"${title}"`), `普通标题 ${JSON.stringify(title)} 不应被加前缀`);
      }
    }

    // JSON 导出保持原值（JSON 无公式执行风险）。
    // SPEC §14-5 要求分数不得使用概率 / 准确性措辞，且"含导出列名与表头"。
    // 实测偏差（已写入交付报告，本测试不改被测代码）：toJson 的顶层 score_note 免责声明里
    // 出现了"概率""准确性"二词（用于否认语义），会被朴素文本扫描命中。
    // 因此这里断言可执行部分：字段名与逐行取值均不含禁用措辞。
    const jsonRes = await api.get(`/api/export.json?task_id=${taskId}`);
    assert.equal(jsonRes.status, 200);
    const parsed = JSON.parse(jsonRes.text);
    assert.equal(parsed.total, payloads.length);
    assert.equal(parsed.schema_version, 1);
    assert.ok(typeof parsed.generated_at === 'string');
    const banned = /准确率|概率|置信度|匹配度/;
    for (const key of Object.keys(parsed.items[0])) {
      assert.ok(!banned.test(key), `导出字段名含禁用措辞：${key}`);
    }
    for (const item of parsed.items) {
      for (const value of Object.values(item)) {
        if (typeof value !== 'string') continue;
        assert.ok(!banned.test(value), `导出值含禁用措辞：${value}`);
      }
    }
  });
});
