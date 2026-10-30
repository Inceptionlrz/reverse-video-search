// tmpfiles.org：POST https://tmpfiles.org/api/v1/upload，单字段 file。保留策略：短周期（默认 60 分钟起）。
// 证据 E-19（形态存在，未验证返回值）。响应为 JSON {data:{url}}，url 形如
// https://tmpfiles.org/api/v1/download?file_id=... 或 https://tmpfiles.org/dl/...；
// 两者对引擎 deeplink 均需可直接取图的地址，这里原样返回，由上层判可用性。
// 实测 2026-10-30（scripts/probe/19-imagehost.mjs 与 20-bridge-e2e.mjs）：
// **上传是成功的**（HTTP 200，约 1.7s，返回 https://tmpfiles.org/<id>/frame.jpg），
// 但那个 URL 返回的是 **text/html 预览页**（约 3KB），不是图片本体；
// 直链形态 /dl/<id> 实测 404。拿这种 URL 去喂引擎 deep link，引擎取不到图，
// 结果必然为空——而上层只看"上传成功"，失败被推迟成莫名的"页面结构无法解析"。
//
// 这正是基类新增 content-type 校验要挡住的情况：宁可当场报"链接不是图片本体"，
// 也不要让 36 个组合跑完才发现全是空结果。
import { BaseImageHost } from './base.mjs';

export class TmpFilesHost extends BaseImageHost {
  constructor() {
    super({
      id: 'tmpfiles',
      label: 'tmpfiles.org',
      endpoint: 'https://tmpfiles.org/api/v1/upload',
      retention: '短周期保留（分钟级到小时级）',
      verified: false,
      notes: '实测（2026-10-30）上传成功但链接是 HTML 预览页而非图片，引擎无法取图，桥接不可用；上传前帧已降质至长边 ≤ 640',
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
