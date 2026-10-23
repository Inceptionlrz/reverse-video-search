// tmpfiles.org：POST https://tmpfiles.org/api/v1/upload，单字段 file。保留策略：短周期（默认 60 分钟起）。
// 证据 E-19（形态存在，未验证返回值）。响应为 JSON {data:{url}}，url 形如
// https://tmpfiles.org/api/v1/download?file_id=... 或 https://tmpfiles.org/dl/...；
// 两者对引擎 deeplink 均需可直接取图的地址，这里原样返回，由上层判可用性。
import { BaseImageHost } from './base.mjs';

export class TmpFilesHost extends BaseImageHost {
  constructor() {
    super({
      id: 'tmpfiles',
      label: 'tmpfiles.org',
      endpoint: 'https://tmpfiles.org/api/v1/upload',
      retention: '短周期保留（分钟级到小时级）',
      verified: false,
      notes: '匿名上传，任何拿到链接的人均可查看；上传前帧已降质至长边 ≤ 640',
    });
  }

  buildForm(buffer, filename) {
    return { fields: [], file: { field: 'file', filename: filename || 'frame.jpg' } };
  }

  parseResponse(body) {
    const text = String(body || '').trim();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 非 JSON 时按纯文本处理
    }
    const url = parsed?.data?.url || parsed?.url || null;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
    if (/^https?:\/\/\S+$/i.test(text)) return text.split(/\s+/)[0];
    return null;
  }
}

export function createTmpFilesHost() {
  return new TmpFilesHost();
}
