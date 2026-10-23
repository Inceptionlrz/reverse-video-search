// catbox.moe：POST https://catbox.moe/user/api.php，字段 reqtype=fileupload + fileToUpload。
// 保留策略：长期/永久（取决于其服务策略）。证据 E-17（形态存在，未验证返回值）。
import { BaseImageHost } from './base.mjs';

export class CatboxHost extends BaseImageHost {
  constructor() {
    super({
      id: 'catbox',
      label: 'catbox.moe',
      endpoint: 'https://catbox.moe/user/api.php',
      retention: '长期保留（取决于 catbox 服务策略，链接公开可达）',
      verified: false,
      notes: '匿名上传，任何拿到链接的人均可查看；上传前帧已降质至长边 ≤ 640',
    });
  }

  buildForm(buffer, filename) {
    return {
      fields: [{ name: 'reqtype', value: 'fileupload' }],
      file: { field: 'fileToUpload', filename: filename || 'frame.jpg' },
    };
  }

  parseResponse(body) {
    const text = String(body || '').trim();
    // 成功返回纯文本 URL；失败返回错误信息（无 http 前缀）。
    if (/^https?:\/\/\S+$/i.test(text)) return text.split(/\s+/)[0];
    return null;
  }
}

export function createCatboxHost() {
  return new CatboxHost();
}
