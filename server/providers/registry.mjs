// 引擎注册表：三引擎实例化 + 按 engine_health 表的 enabled 过滤。
// 过滤发生在「取下一个待处理项」时（调度层单点），不在各 UI 入口重复判断（EARS #30）。
import { createGoogleLensProvider } from './google-lens.mjs';
import { createYandexProvider } from './yandex.mjs';
import { createBingProvider } from './bing.mjs';

export function createEngineRegistry() {
  const engines = new Map();
  for (const factory of [createGoogleLensProvider, createYandexProvider, createBingProvider]) {
    const engine = factory();
    engines.set(engine.id, engine);
  }
  return engines;
}

export function getEngine(engines, id) {
  return engines.get(id) || null;
}

export function listEngines(engines) {
  return [...engines.values()];
}

export function engineIds(engines) {
  return [...engines.keys()];
}

// 判断某引擎当前是否可执行：数据库 enabled + 熔断未开。
// circuitUntilMs 为未来时间戳视为熔断中；越界后由 recordSuccess/resetCircuit 清理。
export function isEngineRunnable(health) {
  if (!health) return { runnable: false, reason: 'PROVIDER_DISABLED', detail: '引擎未注册健康状态' };
  if (!health.enabled) return { runnable: false, reason: 'PROVIDER_DISABLED', detail: '引擎已在设置中停用' };
  if (health.circuit_until_ms && health.circuit_until_ms > Date.now()) {
    const remainSec = Math.ceil((health.circuit_until_ms - Date.now()) / 1000);
    return { runnable: false, reason: 'PROVIDER_DISABLED', detail: `引擎熔断中，剩余 ${remainSec} 秒` };
  }
  return { runnable: true, reason: null, detail: null };
}
