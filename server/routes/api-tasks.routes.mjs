// 任务域路由：建任务（multipart 文件 / JSON 路径或 URL）、列表、详情、确认、抽帧、控制、删除。
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBody, sendFail, sendOk } from '../lib/server/json.mjs';
import { readMultipart } from '../lib/http/multipart-read.mjs';
import { badRequest } from '../lib/errors.mjs';

export function registerTaskRoutes(router, ctx) {
  const { taskService, analysisService, frameService } = ctx.services;

  // POST /api/file-upload：multipart 文件或 JSON（source_path / source_url）
  router.post('/api/file-upload', async (req, res, { requestId }) => {
    const contentType = String(req.headers['content-type'] || '');
    let input;
    if (contentType.startsWith('multipart/form-data')) {
      // 暂存目录除时间戳外必须带随机段：u_<ts> 与 <ts>_<file> 两级命名都只依赖
      // Date.now()，同毫秒内的并发上传会共用同一路径——后一个覆盖前一个，且
      // 删除其中一个任务时会连带删掉另一个任务的源文件（清理按路径判定）。
      const uploadDir = path.join(ctx.cfg.dataDir, 'uploads', `u_${Date.now()}_${randomUUID().slice(0, 8)}`);
      const { fields, files } = await readMultipart(req, { uploadDir });
      const file = files[0];
      if (!file) throw badRequest('multipart 中未找到文件');
      input = {
        source_type: 'file',
        source_path: file.path,
        display_name: fields.title || file.filename,
        extract_mode: fields.extract_mode,
        max_frames: fields.max_frames,
        frame_interval_ms: fields.frame_interval_ms,
        scene_threshold: fields.scene_threshold,
      };
    } else {
      const body = await readBody(req);
      input = {
        source_type: body.source_type === 'url' ? 'url' : 'file',
        source_path: body.source_path,
        source_url: body.source_url,
        display_name: body.display_name || body.title,
        extract_mode: body.extract_mode,
        max_frames: body.max_frames,
        frame_interval_ms: body.frame_interval_ms,
        scene_threshold: body.scene_threshold,
      };
    }
    const created = await taskService.create(input);
    if (created.error) {
      // 预检失败也返回任务体，便于前端展示 ffmpeg 摘要；HTTP 400 + error 信封
      return sendFail(res, created.error, requestId);
    }
    return sendOk(res, { task: created.task, plan: created.plan, poll_interval_ms: 3000 }, { status: 201, requestId });
  });

  router.get('/api/tasks', async (req, res, { query, requestId }) => {
    const result = await taskService.list({
      status: query.get('status'),
      q: query.get('q'),
      limit: query.get('limit'),
      offset: query.get('offset'),
    });
    return sendOk(res, { ...result, limit: Math.min(100, Number(query.get('limit')) || 20), offset: Number(query.get('offset')) || 0 }, { requestId });
  });

  router.get('/api/tasks/:id', async (req, res, { params, requestId }) => {
    return sendOk(res, { task: await taskService.get(params.id) }, { requestId });
  });

  // POST /api/tasks/:id/confirm：授权外发范围（engines 必选；bridge 需同时给 imagehost）
  router.post('/api/tasks/:id/confirm', async (req, res, { params, requestId }) => {
    const body = await readBody(req);
    const scope = {
      engines: body.engines === true || body.scope?.engines === true,
      bridge: body.bridge === true || body.scope?.bridge === true,
      imagehost: body.imagehost ?? body.scope?.imagehost ?? null,
    };
    if (!scope.engines) throw badRequest('确认外发必须授权 engines（把帧发送到公开搜索引擎）');
    if (scope.bridge && !scope.imagehost) throw badRequest('授权图床桥接必须同时选择站点（catbox / 0x0 / tmpfiles）');
    await analysisService.recordConsent(params.id, scope);
    const task = await taskService.setStatus(params.id, { confirmed: 1 });
    return sendOk(res, { task, consent: scope }, { requestId });
  });

  // POST /api/tasks/:id/extract：异步抽帧，返回 202，前端轮询任务详情
  router.post('/api/tasks/:id/extract', async (req, res, { params, requestId }) => {
    const body = await readBody(req);
    const task = await taskService.get(params.id);
    frameService
      .runExtract(params.id, {
        mode: body.mode,
        max_frames: body.max_frames,
        frame_interval_ms: body.frame_interval_ms,
        scene_threshold: body.scene_threshold,
      })
      .catch((err) => ctx.logger.error('frame', 'extract_route', `抽帧任务异常：${err.message}`, { task_id: params.id }));
    return sendOk(
      res,
      { task_id: params.id, status: 'extracting', frame_count: task.frames_done, poll_interval_ms: 1000 },
      { status: 202, requestId },
    );
  });

  // POST /api/tasks/:id/control：pause | resume | cancel | retry-failed
  router.post('/api/tasks/:id/control', async (req, res, { params, requestId }) => {
    const body = await readBody(req);
    if (!['pause', 'resume', 'cancel', 'retry-failed'].includes(body.action)) {
      throw badRequest('未知的控制动作', { allowed: ['pause', 'resume', 'cancel', 'retry-failed'] });
    }
    const result = await analysisService.control(params.id, body.action);
    return sendOk(res, result, { requestId });
  });

  router.del('/api/tasks/:id', async (req, res, { params, requestId }) => {
    return sendOk(res, await taskService.remove(params.id), { requestId });
  });
}
