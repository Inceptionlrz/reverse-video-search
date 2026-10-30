// 0x0.st：POST https://0x0.st/，单字段 file。保留策略：短周期（数天）。
//
// 实测 2026-10-30（scripts/probe/19-imagehost.mjs）：TLS 连接根本建立不起来
// （"Client network socket disconnected before secure TLS connection was established"），
// 直连与经代理都不通。选它必然失败，保留实现只为换网络环境时可直接复用。
import { BaseImageHost } from './base.mjs';

export class X0Host extends BaseImageHost {
  constructor() {
    super({
      id: '0x0',
      label: '0x0.st',
      endpoint: 'https://0x0.st/',
      retention: '短周期保留（数天），过期后链接失效',
      verified: false,
      notes: '实测（2026-10-30）连接不可达：TLS 握手前连接即断开，直连与代理均失败；上传前帧已降质至长边 ≤ 640',
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
