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

  async function markManual(analysisId, { code, message, log, provider, frame, manualUrl }) {
    await finish(analysisId, {
      status: 'manual',
      error_code: code || 'PARSE_ERROR',
      error_message: message,
      manual_path: frame?.file_path ?? null,
      // manualUrl 可能是"已带图片"的深链（省掉手动上传），缺省才回落到上传页。
      manual_url: manualUrl ?? provider?.entryUrl ?? null,
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
    const result = await executeOnce(analysisId);
    // 终态收敛：最后一个作业落终态后，把任务从 analyzing 推到 done。
    // 曾完全没有这一步——全部组合终态后任务永远卡在「分析中」，前端也因此
    // 不再显示「发起检索」按钮（renderActions 只认 frames_ready/done/paused）。
    try {
      const row = await analysesRepo.get(analysisId);
      if (row?.task_id) await settleTaskIfIdle(row.task_id);
    } catch (err) {
      logger.warn('analysis', 'settle_failed', `任务终态收敛失败：${err.message}`, { analysis_id: analysisId });
    }
    return result;
  }

  async function settleTaskIfIdle(taskId) {
    const pending = await analysesRepo.countPendingByTask(taskId);
    if (pending > 0) return;
    const task = await tasksRepo.get(taskId);
    if (task && !task.deleted_at && task.status === 'analyzing') {
      await tasksRepo.update(taskId, { status: 'done', phase: 'done' });
      logger.info('task', 'completed', '全部检索作业已终态，任务标记完成', { task_id: taskId });
    }
  }

  async function executeOnce(analysisId) {
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
      // 站点解析：单任务授权（确认弹窗里选的）优先，设置页的默认站点兜底。
      // 曾在此处只读 settings.provider——用户在弹窗里选了站点也会被无视，
      // 全部组合无声降级为 manual，是「21 个组合全手动」的直接原因之一。
      const consent = await loadConsent(task.id);
      const hostId = settings.imagehost.enabled
        ? (consent?.imagehost || settings.imagehost.provider)
        : null;
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
        const reason = !settings.imagehost.enabled
          ? '图床桥接已在设置页关闭'
          : !hostId
            ? '未选择图床站点（可在确认弹窗勾选桥接时选择，或到设置页设默认站点）'
            : !consent?.bridge
              ? '本任务未确认图床桥接（需在任务确认弹窗中单独授权）'
              : '该引擎的桥接路径实测不可用';
        log.push({ step: 'bridge', skipped: true, reason });
      }

      // [3.5] 手动深链：引擎自动解析拿不到结果，但浏览器里能直接出结果的
      // （Google Lens 实测如此）。有公网 URL 时给用户在浏览器点开的链接，
      // 省掉"自己把帧文件拖进上传页"这一步——这是这类引擎目前唯一能省的动作。
      // 仍然走同一份桥接授权：把帧传到图床是实打实的外发，不能因为"只是手动"就绕过。
      let manualUrl = provider.entryUrl ?? null;
      const manualDeeplinkSupported = typeof provider.buildManualDeeplink === 'function'
        && Boolean(provider.buildManualDeeplink('https://example.invalid/x.jpg'));
      if (manualDeeplinkSupported && hostId && consent?.bridge) {
        const up = await runBridge(ctx, hostId, frame, analysisId, log);
        log.push({ step: 'manual_deeplink', ok: up.ok, code: up.errorCode ?? null, message: up.errorMessage ?? null, imagehost: hostId });
        if (up.ok) {
          const dl = provider.buildManualDeeplink(up.url);
          if (dl) manualUrl = dl;
        }
      } else if (manualDeeplinkSupported) {
        log.push({
          step: 'manual_deeplink',
          skipped: true,
          reason: hostId
            ? '本任务未确认图床桥接，无法生成"已带图片"的链接，只能手动上传文件'
            : '未选择图床站点，无法生成"已带图片"的链接，只能手动上传文件',
        });
      }

      // [4] manual：最后一级的错误码上抛，永不为空
      const finalCode = lastError?.errorCode || 'ENGINE_NO_HTTP_RESULT';
      await health.recordFailure(provider.id, finalCode);
      await markManual(analysisId, {
        code: finalCode,
        // 默认文案曾写「所有自动方式均不可用」，对 Google 是误导：
        // 它不是"暂时不可用"，而是实测 HTTP 层取不到结果。用 provider 自己的结论。
        message: lastError?.errorMessage || provider.notes || '所有自动方式均不可用',
        log,
        provider,
        frame,
        manualUrl,
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
