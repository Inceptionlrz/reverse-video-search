// catbox.moe：POST https://catbox.moe/user/api.php，字段 reqtype=fileupload + fileToUpload。
// 保留策略：长期/永久（取决于其服务策略）。
//
// 实测 2026-10-30（scripts/probe/19-imagehost.mjs）：站点可达，但匿名上传一律
// 返回 **412 Invalid uploader** —— 它已不再接受匿名上传，需要账号 userhash。
// 带 userhash 时会返回 files.catbox.moe 直链图片（content-type: image/*），
// 是三家内置图床里唯一有希望跑通的一家，但要用户自备账号。
import { BaseImageHost } from './base.mjs';

export class CatboxHost extends BaseImageHost {
  constructor() {
    super({
      id: 'catbox',
      label: 'catbox.moe',
      endpoint: 'https://catbox.moe/user/api.php',
      retention: '长期保留（取决于 catbox 服务策略，链接公开可达）',
      verified: false,
      notes: '实测（2026-10-30）匿名上传被拒：HTTP 412 Invalid uploader，需自备账号 userhash；返回直链图片，任何拿到链接的人均可查看；上传前帧已降质至长边 ≤ 640',
    });
  }

  buildForm(buffer, filename) {
    const fields = [{ name: 'reqtype', value: 'fileupload' }];
    // userhash 可选：catbox 免费账号后台可查。填了才有机会通过 412 这道关。
    const hash = process.env.RVS_CATBOX_USERHASH || '';
    if (hash) fields.push({ name: 'userhash', value: hash });
    return {
      fields,
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
