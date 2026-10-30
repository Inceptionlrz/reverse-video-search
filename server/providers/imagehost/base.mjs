// 图床适配器基类。上传前由调用方完成降质（长边 ≤ 640、JPEG q=3，见 media/encode.mjs）。
// 三家图床均为「用户显式开启 + 单任务确认」后才可用（SPEC §10），默认关闭。
// 注意：图床返回的 URL 会写入 analyses.request_url，结果必须标注"该帧曾由第三方图床中转"。
import { buildMultipart } from '../../lib/http/multipart.mjs';
import { trackedRequest } from '../base.mjs';
import { request } from '../../lib/http/request.mjs';

/**
 * 判断"图床返回的链接"能不能真被引擎取到图。
 *
 * 抽成纯函数是为了可测：上传要发真实网络请求，ESM 导出又不可桩，
 * 不抽出来就只能靠"源码里有没有这行字"这种自我安慰式断言。
 * 判定规则本身很简单，但它是"假成功"与"明确失败"的分界，必须有真测试。
 */
export function classifyImageUrl(probe) {
  if (!probe || !probe.ok) {
    return {
      ok: false,
      reason: `无法取回（${probe?.errorMessage || `HTTP ${probe?.status ?? '无响应'}`}）`,
    };
  }
  const ctype = String(probe.headers?.['content-type'] || '').toLowerCase();
  if (!ctype.startsWith('image/')) {
    return { ok: false, reason: `不是图片本体（content-type=${ctype || '未知'}）` };
  }
  return { ok: true, reason: null };
}

export class BaseImageHost {
  constructor({ id, label, endpoint, retention, verified = false, notes = '' }) {
    this.id = id;
    this.label = label;
    this.endpoint = endpoint;
    this.retention = retention; // 保留策略说明（UI 透明展示）
    this.verified = verified;
    this.notes = notes;
  }

  // 子类实现：返回 { fields: [{name,value}], file: {field, filename} }
  buildForm(buffer, filename) {
    return { fields: [], file: { field: 'file', filename: filename || 'frame.jpg' } };
  }

  // 子类实现：把响应体解析为公网图片 URL；失败返回 null。
  parseResponse(body) {
    return null;
  }

  async upload(ctx, { buffer, filename }) {
    const form = this.buildForm(buffer, filename);
    const mp = buildMultipart({ fields: form.fields, files: [{ ...form.file, content: buffer, contentType: 'image/jpeg' }] });
    const metrics = ctx?.metrics;
    if (metrics) {
      metrics.imagehostRequests[this.id] = (metrics.imagehostRequests[this.id] || 0) + 1;
    }
    const res = await trackedRequest(ctx, this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': mp.contentType },
      body: mp.body,
    });
    if (!res.ok) {
      return { ok: false, errorCode: res.errorCode, errorMessage: `${this.label} 上传失败：${res.errorMessage}` };
    }
    const url = this.parseResponse(res.body);
    if (!url) {
      return { ok: false, errorCode: 'UPLOAD_REJECTED', errorMessage: `${this.label} 返回了无法解析的响应` };
    }
    // 拿到链接不等于能用：图床常返回 HTML 预览页而不是图片本体。
    // 实测 tmpfiles.org 上传 200 成功、链接 https://tmpfiles.org/<id>/frame.jpg
    // 却返回 text/html（3KB 预览页），拿它去喂引擎 deep link 只能得到空结果，
    // 而上层只看到"上传成功"，失败被推迟成莫名其妙的"页面结构无法解析"。
    // 这里当场校验 content-type，把假成功变成明确失败。
    const probe = await request(url, {
      method: 'GET',
      config: ctx?.cfg,
      proxy: ctx?.cfg?.proxy,
      maxBodyBytes: 1024,
      ttfbTimeoutMs: ctx?.cfg?.net?.ttfbTimeoutMs,
      totalTimeoutMs: ctx?.cfg?.net?.totalTimeoutMs,
    });
    // 注意：我们自己都取不到，引擎更取不到——不能算成功。
    // 措辞留余地：本地网络抖动也会走到这里，别把话说成图床坏了。
    const verdict = classifyImageUrl(probe);
    if (!verdict.ok) {
      return {
        ok: false,
        errorCode: 'UPLOAD_REJECTED',
        errorMessage: `${this.label} 的链接${verdict.reason}，不能据此发起检索`,
        detail: url,
      };
    }
    return { ok: true, url, requestUrl: this.endpoint, httpStatus: res.status };
  }
}
