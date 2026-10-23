// 引擎健康服务：熔断策略、连通性自测、状态聚合。
// 熔断规则（SPEC §11）：连续 3 次 RATE_LIMITED / FORBIDDEN → 熔断 10 分钟。
// ZERO_RESULT 不是失败，不计入熔断（ARCHITECTURE §14.10）。
import { request } from '../lib/http/request.mjs';
import { getConfig } from '../lib/config.mjs';

const CIRCUIT_CODES = new Set(['RATE_LIMITED', 'FORBIDDEN']);
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_MS = 10 * 60 * 1000;

export function createEngineHealthService({ engineHealthRepo, logger }) {
  const cfg = getConfig();

  async function ensureAll(engines) {
    for (const engine of engines.values()) await engineHealthRepo.ensure(engine.id);
  }

  async function list(engines) {
    await ensureAll(engines);
    const rows = await engineHealthRepo.list();
    const byId = new Map(rows.map((r) => [r.provider, r]));
    return [...engines.values()].map((engine) => {
      const row = byId.get(engine.id) || {};
      const circuitOpen = Boolean(row.circuit_until_ms && row.circuit_until_ms > Date.now());
      return {
        id: engine.id,
        label: engine.label,
        enabled: row.enabled !== 0,
        availability: engine.availability,
        notes: engine.notes,
        entry_url: engine.entryUrl,
        consecutive_failures: row.consecutive_failures ?? 0,
        circuit_open: circuitOpen,
        circuit_remaining_sec: circuitOpen ? Math.ceil((row.circuit_until_ms - Date.now()) / 1000) : 0,
        last_success_ms: row.last_success_ms ?? null,
        last_failure_ms: row.last_failure_ms ?? null,
        last_error_code: row.last_error_code ?? null,
      };
    });
  }

  async function setEnabled(provider, enabled) {
    await engineHealthRepo.setEnabled(provider, Boolean(enabled));
    logger.info('engine', 'enabled_changed', `引擎 ${provider} ${enabled ? '已启用' : '已停用'}`, { provider });
    return { provider, enabled: Boolean(enabled) };
  }

  async function recordSuccess(provider) {
    await engineHealthRepo.recordSuccess(provider);
  }

  async function recordFailure(provider, errorCode) {
    const row = await engineHealthRepo.get(provider);
    const next = (row?.consecutive_failures ?? 0) + 1;
    const circuit = CIRCUIT_CODES.has(errorCode) && next >= CIRCUIT_THRESHOLD ? Date.now() + CIRCUIT_MS : null;
    await engineHealthRepo.recordFailure(provider, errorCode, circuit);
    if (circuit) {
      logger.warn('engine', 'circuit_open', `引擎 ${provider} 连续失败 ${next} 次，熔断 10 分钟`, { provider, error_code: errorCode });
    }
  }

  // 连通性自测：请求引擎入口页，整体超时 6s。HTTP 状态恒 200，可达性在 data 中表达。
  async function probe(engines, provider, metrics) {
    const engine = engines.get(provider);
    if (!engine) return { provider, reachable: false, error_code: 'NOT_FOUND', error_message: '引擎不存在' };
    if (metrics) metrics.providerProbes = (metrics.providerProbes || 0) + 1;
    const res = await request(engine.entryUrl, {
      config: cfg,
      proxy: cfg.proxy,
      method: 'GET',
      totalTimeoutMs: 6000,
      ttfbTimeoutMs: 4000,
    });
    if (!res.ok) {
      logger.warn('engine', 'probe_failed', `引擎 ${provider} 不可达：${res.errorMessage}`, { provider, error_code: res.errorCode });
      return { provider, reachable: false, error_code: res.errorCode, error_message: res.errorMessage, latency_ms: res.latencyMs ?? null };
    }
    logger.info('engine', 'probe_ok', `引擎 ${provider} 可达（${res.latencyMs}ms）`, { provider });
    return { provider, reachable: true, error_code: null, error_message: null, latency_ms: res.latencyMs ?? null, http_status: res.status };
  }

  return { list, setEnabled, recordSuccess, recordFailure, probe, ensureAll };
}
