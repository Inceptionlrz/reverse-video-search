// 分析服务（协调层）：提交、查询、控制（暂停/恢复/取消/重试失败）、断点恢复、授权记录。
// 降级链路实现在 analysis-execute.mjs；本文件不写任何链路细节。
// provider 停用/熔断的过滤发生在调度层（enqueue 前与断点恢复时各一处），
// 不在各 UI 入口重复判断（EARS #30）。
import { newAnalysisId } from '../lib/ids.mjs';
import { badRequest, consentRequired, notFound } from '../lib/errors.mjs';
import { isEngineRunnable } from '../providers/registry.mjs';
import { createExecutor } from './analysis-execute.mjs';

const CONSENT_KEY = (taskId) => `consent:${taskId}`;

function safeParse(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createAnalysisService(deps) {
  const {
    tasksRepo, framesRepo, analysesRepo, engineHealthRepo, settingsRepo,
    engines, imageHosts, resultService, logger, runner,
  } = deps;
  const health = deps.health;
  const cancelTokens = deps.cancelTokens || new Map();
  const inFlight = new Set();
  const metrics = deps.metrics || { providerRequests: {}, imagehostRequests: {} };
  const settingsService = deps.settingsService;
  const executor = createExecutor({
    tasksRepo,
    framesRepo,
    analysesRepo,
    engineHealthRepo,
    engines,
    imageHosts,
    resultService,
    health,
    logger,
    metrics,
    cancelTokens,
    settingsService,
  });

  async function loadConsent(taskId) {
    const row = await settingsRepo.get(CONSENT_KEY(taskId));
    return row?.value && typeof row.value === 'object' ? row.value : null;
  }

  // 调度层 provider 过滤（EARS #30 单点）：不可运行的引擎直接落 manual，不入队、不发请求。
  async function gateOrManual(row) {
    const gate = isEngineRunnable(await engineHealthRepo.ensure(row.provider));
    if (gate.runnable) return false;
    const provider = engines.get(row.provider);
    await analysesRepo.update(row.id, {
      status: 'manual',
      error_code: 'PROVIDER_DISABLED',
      error_message: gate.detail,
      manual_url: provider?.entryUrl ?? null,
      finished_ms: Date.now(),
      degradation_log: JSON.stringify([{ step: 0, ok: false, code: 'PROVIDER_DISABLED', message: gate.detail }]),
    });
    logger.info('analysis', 'gated', `调度层拦截：${gate.detail}`, { analysis_id: row.id, provider: row.provider });
    return true;
  }

  async function enqueue(rows) {
    let enqueued = 0;
    for (const row of rows) {
      if (inFlight.has(row.id)) continue;
      if (await gateOrManual(row)) continue;
      inFlight.add(row.id);
      enqueued += 1;
      runner
        .enqueue(row.provider, async () => {
          try {
            return await executor.execute(row.id);
          } finally {
            inFlight.delete(row.id);
          }
        })
        .catch(() => {}); // 取消导致的 reject 在此吞掉，状态已由行记录表达
    }
    return enqueued;
  }

  async function run(taskId, input = {}) {
    const task = await tasksRepo.get(taskId);
    if (!task || task.deleted_at) throw notFound('任务不存在', { task_id: taskId });
    if (!['frames_ready', 'analyzing', 'paused', 'done'].includes(task.status)) {
      throw badRequest('任务尚未抽帧或状态不允许分析', { status: task.status });
    }
    if (input.consent_ack !== true) throw consentRequired('必须显式确认外发 consentAck 才能发起检索');
    const consent = await loadConsent(taskId);
    if (!task.confirmed || !consent?.engines) throw consentRequired('任务未确认：请先在确认弹窗中授权外发');

    const requestedBridge = input.options?.allow_bridge === true;
    if (requestedBridge && !(consent.bridge && consent.imagehost)) {
      throw consentRequired('图床桥接未在本任务确认范围内', { hint: '在确认弹窗中勾选图床桥接并选择站点' });
    }

    let frames = await framesRepo.listByTask(taskId, { enabledOnly: true, includeDuplicates: false });
    if (Array.isArray(input.frame_ids) && input.frame_ids.length) {
      const allow = new Set(input.frame_ids);
      frames = frames.filter((f) => allow.has(f.id));
    }
    if (!frames.length) throw badRequest('没有可分析的帧（请先抽帧并启用帧）');

    const providerIds = Array.isArray(input.providers) && input.providers.length
      ? input.providers.filter((id) => engines.has(id))
      : [...engines.keys()];
    if (!providerIds.length) throw badRequest('没有可用的引擎');

    const rows = [];
    for (const frame of frames) {
      for (const providerId of providerIds) {
        const existing = await analysesRepo.findByFrameProvider(frame.id, providerId);
        if (existing) {
          if (['queued', 'running'].includes(existing.status)) {
            rows.push(existing);
            continue;
          }
          await analysesRepo.resetForRetry(taskId, [existing.id]);
          rows.push({ id: existing.id, provider: providerId, frame_id: frame.id });
          continue;
        }
        const id = newAnalysisId();
        await analysesRepo.insert({ id, task_id: taskId, frame_id: frame.id, provider: providerId, status: 'queued', created_ms: Date.now() });
        rows.push({ id, provider: providerId, frame_id: frame.id });
      }
    }

    await tasksRepo.update(taskId, { status: 'analyzing', phase: 'analyzing', analyses_total: rows.length, analyses_done: 0 });
    const enqueued = await enqueue(rows);
    logger.info('analysis', 'run', `已提交 ${rows.length} 个分析作业（入队 ${enqueued}）`, { task_id: taskId, providers: providerIds });
    return { task_id: taskId, status: 'analyzing', analyses: rows.map((r) => ({ id: r.id, provider: r.provider, frame_id: r.frame_id })), enqueued };
  }

  async function get(analysisId) {
    const row = await analysesRepo.get(analysisId);
    if (!row) throw notFound('分析不存在', { analysis_id: analysisId });
    return { ...row, degradation_log: safeParse(row.degradation_log) };
  }

  async function listByTask(taskId) {
    const rows = await analysesRepo.listByTask(taskId, { limit: 2000 });
    const frames = await framesRepo.listByTask(taskId, {});
    const seqOf = new Map(frames.map((f) => [f.id, f.seq]));
    return rows.map((r) => ({ ...r, frame_seq: seqOf.get(r.frame_id) ?? null, degradation_log: safeParse(r.degradation_log) }));
  }

  async function control(taskId, action) {
    const task = await tasksRepo.get(taskId);
    if (!task || task.deleted_at) throw notFound('任务不存在', { task_id: taskId });
    if (action === 'pause') {
      runner.pause();
      await tasksRepo.update(taskId, { status: 'paused', phase: 'paused' });
      return { status: 'paused' };
    }
    if (action === 'resume') {
      await tasksRepo.update(taskId, { status: 'analyzing', phase: 'analyzing' });
      const queued = await analysesRepo.listByStatus(['queued'], { limit: 2000 });
      const enqueued = await enqueue(queued.filter((r) => r.task_id === taskId));
      runner.resume();
      return { status: 'analyzing', enqueued };
    }
    if (action === 'cancel') {
      const token = cancelTokens.get(taskId);
      if (token) token.abort('user cancelled');
      const queued = await analysesRepo.listByStatus(['queued', 'running'], { limit: 2000 });
      let n = 0;
      for (const row of queued) {
        if (row.task_id !== taskId || row.status === 'running') continue; // 运行中交由取消令牌中断
        await analysesRepo.update(row.id, { status: 'cancelled', finished_ms: Date.now(), error_code: 'CANCELLED', error_message: '用户取消' });
        n += 1;
      }
      await tasksRepo.update(taskId, { status: 'cancelled', phase: 'cancelled' });
      return { status: 'cancelled', cancelled: n };
    }
    if (action === 'retry-failed') {
      const retryable = await analysesRepo.selectRetryable(taskId);
      if (!retryable.length) return { status: task.status, retried: 0 };
      const ids = retryable.map((r) => r.id);
      await analysesRepo.resetForRetry(taskId, ids);
      const rows = ids.map((id) => ({ id, provider: retryable.find((r) => r.id === id).provider }));
      const enqueued = await enqueue(rows);
      await tasksRepo.update(taskId, { status: 'analyzing', phase: 'analyzing' });
      return { status: 'analyzing', retried: ids.length, enqueued };
    }
    throw badRequest('未知的控制动作', { action });
  }

  // 断点恢复入口：进程重启后把排队项按 provider 可运行性过滤后重新入队。
  async function resumeQueued() {
    const queued = await analysesRepo.listByStatus(['queued'], { limit: 5000 });
    return enqueue(queued);
  }

  async function recordConsent(taskId, scope) {
    await settingsRepo.set(CONSENT_KEY(taskId), {
      engines: scope?.engines === true,
      bridge: scope?.bridge === true,
      imagehost: scope?.imagehost ?? null,
      at: Date.now(),
    });
    return loadConsent(taskId);
  }

  return { run, get, listByTask, control, resumeQueued, recordConsent, executor, metrics, cancelTokens };
}
