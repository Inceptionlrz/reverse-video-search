#!/usr/bin/env node
// 进程入口：确保 --experimental-sqlite 门旗（缺失则自重新执行），装配应用并监听。
// 合规红线：绑定地址必须是回环；app.assertBindAddress() 不满足时直接退出（不 fallback）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REQUIRED_FLAGS = ['--experimental-sqlite'];
const SELF = fileURLToPath(import.meta.url);

function hasRequiredFlags() {
  return REQUIRED_FLAGS.every((flag) => process.execArgv.includes(flag));
}

if (!hasRequiredFlags()) {
  // 自重新执行：带上门旗，其余参数原样透传，stdio 继承以保持日志可见。
  const child = spawn(process.execPath, [...REQUIRED_FLAGS, ...process.execArgv, SELF, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
} else {
  const { createApp } = await import('../app.mjs');
  let app;
  try {
    app = await createApp();
    await app.listen();
  } catch (err) {
    process.stderr.write(`[rvs] 启动失败：${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
  process.stdout.write(`RVS ready on http://${app.cfg.host}:${app.cfg.port}\n`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`[rvs] 收到 ${signal}，正在关闭…\n`);
    try {
      await app.close();
    } catch {
      // 关闭异常不阻塞退出
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
