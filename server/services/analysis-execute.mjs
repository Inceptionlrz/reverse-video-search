// 降级链路执行体：四级链路的唯一实现（ARCHITECTURE §5）。
// 由 analysis.service 以 createExecutor(deps) 装配；本文件不感知 HTTP 与路由。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../lib/config.mjs';
import { prepareForUpload } from '../lib/media/encode.mjs';
import { isEngineRunnable } from '../providers/registry.mjs';

export function isPublicHttpUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost|0\.0\.0\.0|::1$)/i.test(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function createExecutor(deps) {
  const {
    tasksRepo, framesRepo, analysesRepo, engineHealthRepo,
    engines, imageHosts, resultService, health, logger, metrics, cancelTokens, settingsService,
    // 单任务授权读取器：consent 存在 settings 表但读取逻辑归 analysis.service，
    // 执行层只接受注入，不自己拼 key，避免两处各写一份造成偏移。
    loadConsent,
  } = deps;
  const cfg = getConfig();

  const loadSettings = () => settingsService.load();

  function resolvePublicUrl(task) {
    if (!task || task.source_type !== 'url' || !task.source_url) return null;
    return isPublicHttpUrl(task.source_url);
  }

  async function finish(analysisId, patch) {
    await analysesRepo.update(analysisId, { finished_ms: Date.now(), ...patch });
  }

  async function markManual(analysisId, { code, message, log, provider, frame }) {
    await finish(analysisId, {
      status: 'manual',
      error_code: code || 'PARSE_ERROR',
      error_message: message,
      manual_path: frame?.file_path ?? null,
      manual_url: provider?.entryUrl ?? null,
      degradation_log: JSON.stringify(log),
    });
    logger.info('analysis', 'manual', `已降级为手工模式：${message}`, { analysis_id: analysisId, provider: provider?.id });
  }

  async function succeed(analysisId, { provider, frame, task, items, attemptMode, hitSource, requestUrl, httpStatus, latencyMs, log, imagehost }) {
    await health.recordSuccess(provider.id);
    await finish(analysisId, {
      status: 'succeeded',
      attempt_mode: attemptMode,
      hit_source: hitSource,
      request_url: requestUrl ?? null,
      http_status: httpStatus ?? null,
      latency_ms: latencyMs ?? null,
      degradation_log: JSON.stringify(log),
      error_code: null,
      error_message: null,
    });
    await resultService.ingest({ analysis: { id: analysisId, provider: provider.id }, frame, task, items });
    logger.info('analysis', 'succeeded', `${provider.label} 命中 ${items.length} 条（${attemptMode}${imagehost ? ` via ${imagehost}` : ''}）`, {
      analysis_id: analysisId,
      items: items.length,
    });
    return { status: 'succeeded', items: items.length };
  }

  async function finishZero(analysisId, attemptMode, log) {
    await finish(analysisId, { status: 'zero_result', attempt_mode: attemptMode, hit_source: null, degradation_log: JSON.stringify(log) });
    return { status: 'zero_result' };
  }

  async function runBridge(ctx, hostId, frame, analysisId, log) {
    const host = imageHosts.get(hostId);
    if (!host) return { ok: false, errorCode: 'UPLOAD_REJECTED', errorMessage: `图床 ${hostId} 未注册` };
    const prepared = path.join(cfg.cacheDir, `bridge_${frame.id}.jpg`);
    let up = null;
    try {
      await prepareForUpload(cfg, { input: frame.file_path, output: prepared });
      up = await host.upload(ctx, { buffer: fs.readFileSync(prepared), filename: `${frame.id}.jpg` });
    } catch (err) {
      up = { ok: false, errorCode: 'UPLOAD_REJECTED', errorMessage: `图床桥接失败：${err.message}` };
    } finally {
      fs.rmSync(prepared, { force: true });
    }
    log.push({ step: 'bridge', ok: up.ok, code: up.errorCode ?? null, message: up.errorMessage ?? null, imagehost: hostId });
    return up;
  }

  // 主执行体：返回终态 {status}。任何异常都收敛为 manual（永不让 analysis 悬挂在 running）。
  async function execute(analysisId) {
    const row = await analysesRepo.get(analysisId);
    if (!row || row.status !== 'queued') return { skipped: true };
    const frame = await framesRepo.get(row.frame_id);
    const task = await tasksRepo.get(row.task_id);
    const provider = engines.get(row.provider);
    if (!frame || !task || !provider) {
      await finish(analysisId, { status: 'failed', error_code: 'NOT_FOUND', error_message: '帧、任务或引擎缺失' });
      return { skipped: true };
    }

    const settings = await loadSettings();
    const ctx = { cfg, providerId: provider.id, metrics, cancelToken: cancelTokens.get(task.id) || null };
    const log = [];
    const engineModes = settings.engines[provider.id] || {};
    let lastError = null;

    await analysesRepo.update(analysisId, { status: 'running', started_ms: Date.now(), attempt_mode: null, error_code: null, error_message: null });

    try {
      // [0] 前置判定：引擎停用 / 熔断 / 离线 → 直接 manual，不发请求
      const gate = isEngineRunnable(await engineHealthRepo.ensure(provider.id));
      if (!gate.runnable) {
        await markManual(analysisId, { code: 'PROVIDER_DISABLED', message: gate.detail, log: [{ step: 0, ok: false, code: 'PROVIDER_DISABLED', message: gate.detail }], provider, frame });
        return { status: 'manual' };
      }
      if (cfg.offline) {
        await markManual(analysisId, {
          code: 'NETWORK_ERROR',
          message: '当前离线模式（RVS_OFFLINE=1），未发起任何外网请求',
          log: [{ step: 0, ok: false, code: 'NETWORK_ERROR', message: 'offline mode' }],
          provider,
          frame,
        });
        return { status: 'manual' };
      }

      // [1] upload 直传（默认关，实验性）
      if (engineModes.upload) {
        const res = await provider.searchByUpload(ctx, { frame, task });
        log.push({ step: 'upload', ok: res.ok, code: res.errorCode ?? null, message: res.errorMessage ?? null });
        if (res.ok && res.items?.length) {
          return succeed(analysisId, { provider, frame, task, items: res.items, attemptMode: 'upload', hitSource: 'engine_upload', requestUrl: res.requestUrl ?? null, httpStatus: res.httpStatus ?? null, latencyMs: res.latencyMs ?? null, log });
        }
        lastError = res;
      } else {
        log.push({ step: 'upload', skipped: true, reason: 'multipart 直传默认关闭（实验性，未验证端点）' });
      }

      // [2] deeplink 深链（需要公网 URL）
      const publicUrl = resolvePublicUrl(task);
      if (engineModes.deeplink && publicUrl && provider.availability.deeplink !== 'unavailable') {
        const res = await provider.searchByDeeplink(ctx, publicUrl);
        log.push({ step: 'deeplink', ok: res.ok, code: res.errorCode ?? null, message: res.errorMessage ?? null, url: res.requestUrl ?? null });
        if (res.ok) {
          if (res.items.length) {
            return succeed(analysisId, { provider, frame, task, items: res.items, attemptMode: 'deeplink', hitSource: 'engine_deeplink', requestUrl: res.requestUrl, httpStatus: res.httpStatus, latencyMs: res.latencyMs, log });
          }
          await health.recordSuccess(provider.id);
          return finishZero(analysisId, 'deeplink', log);
        }
        lastError = res;
      } else {
        const reason = !publicUrl
          ? '本地帧对公网引擎不可达（无公网图片 URL）'
          : provider.availability.deeplink === 'unavailable'
            ? `该引擎深链实测不可用：${provider.notes}`
            : '深链开关已关闭';
        log.push({ step: 'deeplink', skipped: true, reason });
      }

      // [3] bridge 图床桥接（设置开 + 单任务确认 + 已选站点 + 引擎支持深链）
      const consent = await loadConsent(task.id);
      const hostId = settings.imagehost.enabled ? settings.imagehost.provider : null;
      const bridgeAllowed = Boolean(hostId) && Boolean(consent?.bridge) && provider.availability.bridge !== 'unavailable';
      if (bridgeAllowed) {
        const up = await runBridge(ctx, hostId, frame, analysisId, log);
        if (up.ok) {
          const res = await provider.searchByDeeplink(ctx, up.url);
          log.push({ step: 'bridge_deeplink', ok: res.ok, code: res.errorCode ?? null, message: res.errorMessage ?? null, url: res.requestUrl ?? up.url });
          if (res.ok && res.items.length) {
            return succeed(analysisId, { provider, frame, task, items: res.items, attemptMode: 'bridge', hitSource: 'imagehost_bridge', requestUrl: up.url, httpStatus: res.httpStatus, latencyMs: res.latencyMs, log, imagehost: hostId });
          }
          if (res.ok) {
            await health.recordSuccess(provider.id);
            return finishZero(analysisId, 'bridge', log);
          }
          lastError = res;
        } else {
          lastError = up;
        }
      } else {
        const reason = !hostId
          ? '未选择图床站点（设置页三选一）'
          : !consent?.bridge
            ? '本任务未确认图床桥接（需在任务确认弹窗中单独授权）'
            : '该引擎的桥接路径实测不可用';
        log.push({ step: 'bridge', skipped: true, reason });
      }

      // [4] manual：最后一级的错误码上抛，永不为空
      await health.recordFailure(provider.id, lastError?.errorCode || 'PARSE_ERROR');
      await markManual(analysisId, {
        code: lastError?.errorCode || 'PARSE_ERROR',
        message: lastError?.errorMessage || '所有自动方式均不可用',
        log,
        provider,
        frame,
      });
      return { status: 'manual' };
    } catch (err) {
      logger.error('analysis', 'execute_error', `执行异常：${err.message}`, { analysis_id: analysisId });
      await markManual(analysisId, { code: 'INTERNAL', message: `执行异常：${err.message}`, log, provider, frame });
      return { status: 'manual' };
    }
  }

  return { execute };
}
