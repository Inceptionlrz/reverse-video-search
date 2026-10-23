// 0x0.st：POST https://0x0.st/，单字段 file。保留策略：短周期（数天）。
// 证据 E-18（形态存在，未验证返回值）。
import { BaseImageHost } from './base.mjs';

export class X0Host extends BaseImageHost {
  constructor() {
    super({
      id: '0x0',
      label: '0x0.st',
      endpoint: 'https://0x0.st/',
      retention: '短周期保留（数天），过期后链接失效',
      verified: false,
      notes: '匿名上传，任何拿到链接的人均可查看；上传前帧已降质至长边 ≤ 640',
    });
  }

  buildForm(buffer, filename) {
    return { fields: [], file: { field: 'file', filename: filename || 'frame.jpg' } };
  }

  parseResponse(body) {
    const text = String(body || '').trim();
    if (/^https?:\/\/\S+$/i.test(text)) return text.split(/\s+/)[0];
    return null;
  }
}

export function createX0Host() {
  return new X0Host();
}
