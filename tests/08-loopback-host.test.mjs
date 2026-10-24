// 回归测试（commit 7420041）：非回环 RVS_HOST 必须拒绝启动，不得静默改写。
//
// 背景：修复前 server/lib/config.mjs 对非回环 host 做静默 fallback：
//   const host = assertLoopback(hostRaw) ? hostRaw : '127.0.0.1';
// 后果是 server/app.mjs 的 assertBindAddress() 成为不可达死代码——
// 它永远看不到非回环值，"启动自检失败即退出"这条合规红线实际由静默改写兜底，
// 与代码注释、SPEC §0.5 / EARS #24、以及团队硬性约束直接矛盾。
//
// 修复改为 loadConfig 直接抛错。两条路径都要锁：
//   1. loadConfig 层：非回环值抛错（主防线）
//   2. app.assertBindAddress() 层：即使 cfg.host 被外部改成非回环也抛错（纵深防御，代码仍保留）
//
// loadConfig 是纯函数（fs.mkdirSync 在独立的 ensureDirs 里），host 校验在任何 IO 之前，
// 因此本文件不会因抛错而污染文件系统。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { loadConfig } from '../server/lib/config.mjs';
import {
  makeOfflineConfig,
  startApp,
} from './helpers.mjs';

// 非回环值：三类常见误配 + 空串边界说明
const NON_LOOPBACK = ['0.0.0.0', '192.168.1.5', '10.0.0.8', '::', 'example.com', '[::1]'];
// 合法回环值（大小写与空白也应被容忍，assertLoopback 内部 trim + toLowerCase）
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

function tmpDataDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rvs-host-')), 'data');
}

describe('回环绑定：非回环 RVS_HOST 拒绝启动（SPEC §0.5 / EARS #24）', () => {
  test('L1：非回环 RVS_HOST 使 loadConfig 抛错，且错误信息可操作', () => {
    for (const host of NON_LOOPBACK) {
      assert.throws(
        () => loadConfig({ RVS_HOST: host, RVS_DATA_DIR: tmpDataDir() }),
        (err) => {
          assert.match(err.message, new RegExp(`RVS_HOST=${escapeRegExp(host)}`),
            `错误信息应回显出问题值 ${host}`);
          assert.match(err.message, /回环/, '错误信息应说明原因是"不是回环地址"');
          assert.match(err.message, /拒绝启动/, '错误信息应表明后果是拒绝启动');
          return true;
        },
        `RVS_HOST=${host} 必须抛错`,
      );
    }
  });

  test('L2：合法回环值均加载成功，且 cfg.host 原样返回（不被改写）', () => {
    for (const host of LOOPBACK) {
      const cfg = loadConfig({ RVS_HOST: host, RVS_DATA_DIR: tmpDataDir() });
      assert.equal(cfg.host, host,
        `cfg.host 应原样返回 ${host}，实际 ${cfg.host}（修复前会被静默改写成 127.0.0.1）`);
    }
  });

  test('L3：大小写与首尾空白的回环值被归一化后存储（校验与存储同一归一化值）', () => {
    // 2026-10-24 裁定（团队负责人）：assertLoopback() 内部 trim + toLowerCase 判定，
    // cfg.host 存储同一归一化结果——校验什么就存什么，日志与 /api/settings 的
    // read_only.server.host 不再出现 'LOCALHOST' / 带空格原值。
    // 注意这与"静默改写"有本质区别：只整理合法值的形态，不把非回环值替换成 127.0.0.1。
    for (const [raw, want] of [['LOCALHOST', 'localhost'], [' 127.0.0.1 ', '127.0.0.1'], ['LocalHost', 'localhost']]) {
      const cfg = loadConfig({ RVS_HOST: raw, RVS_DATA_DIR: tmpDataDir() });
      assert.equal(cfg.host, want, `${raw} 应归一化为 ${want}`);
    }
  });

  test('L4：未设置 RVS_HOST 时默认 127.0.0.1', () => {
    const cfg = loadConfig({ RVS_DATA_DIR: tmpDataDir() });
    assert.equal(cfg.host, '127.0.0.1', '默认必须绑定 127.0.0.1');
  });

  test('L5：RVS_HOST 为空串时回落到默认 127.0.0.1（不视为非回环误配）', () => {
    // config.mjs 用 env.RVS_HOST || '127.0.0.1'，空串走默认值分支而非抛错——
    // 这是有意的边界：空串表示"未配置"，与配置了错误值是两回事。
    const cfg = loadConfig({ RVS_HOST: '', RVS_DATA_DIR: tmpDataDir() });
    assert.equal(cfg.host, '127.0.0.1');
  });

  test('L6：抛错发生在任何目录创建之前，不污染文件系统', () => {
    // loadConfig 的 host 校验在函数体前几行，fs.mkdirSync 只在独立的 ensureDirs() 里。
    // 用不存在的深层路径验证：若 loadConfig 会建目录，这里必然已落地。
    const ghost = path.join(os.tmpdir(), `rvs-ghost-${Date.now()}`, 'nested', 'data');
    assert.throws(() => loadConfig({ RVS_HOST: '0.0.0.0', RVS_DATA_DIR: ghost }), /拒绝启动/);
    assert.equal(fs.existsSync(ghost), false, 'loadConfig 抛错时不得创建任何目录');
  });

  test('L7：纵深防御——cfg.host 被外部改成非回环时 app.assertBindAddress() 仍抛错', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    // 正常启动时自检通过
    assert.equal(app.assertBindAddress(), true, '合法回环地址应通过自检');

    // 模拟配置被外部篡改（修复前这条路径不可达，因为 loadConfig 已静默改写）
    app.cfg.host = '0.0.0.0';
    assert.throws(() => app.assertBindAddress(), (err) => {
      assert.match(err.message, /0\.0\.0\.0/, '错误信息应回显出问题的 host');
      assert.match(err.message, /回环/, '错误信息应说明只允许回环地址');
      return true;
    }, 'cfg.host 为非回环时 assertBindAddress 必须抛错');

    // 其余非回环值同样被纵深防御拦住
    for (const host of ['192.168.1.5', '::']) {
      app.cfg.host = host;
      assert.throws(() => app.assertBindAddress(), new RegExp(host.replace(/[.[\]()*+?^${|}]/g, '\\$&')),
        `assertBindAddress 应拦截 ${host}`);
    }
  });
});

// 工具：把字符串安全包进 RegExp（L1 里要匹配含 . 的主机名）
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
