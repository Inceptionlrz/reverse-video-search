// 图床适配器基类。上传前由调用方完成降质（长边 ≤ 640、JPEG q=3，见 media/encode.mjs）。
// 三家图床均为「用户显式开启 + 单任务确认」后才可用（SPEC §10），默认关闭。
// 注意：图床返回的 URL 会写入 analyses.request_url，结果必须标注"该帧曾由第三方图床中转"。
import { buildMultipart } from '../../lib/http/multipart.mjs';
import { trackedRequest } from '../base.mjs';

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
    return { ok: true, url, requestUrl: this.endpoint, httpStatus: res.status };
  }
}
