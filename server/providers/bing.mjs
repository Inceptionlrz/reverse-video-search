// Bing 适配器。deeplink 已验证可用（证据：scripts/probe/bing.html，35 个 iusc 结果项）。
// 深链形态（E-09/E-10/E-13~E-15）：
//   GET https://www.bing.com/images/searchbyimage/upload?imgurl=<encoded>&cbir=sbi
//   随后重定向到 view=detailv2&iss=sbi 结果页；request.mjs 不自动跟随重定向，
//   因此这里对 3xx 的 Location 再取一次（最多 2 跳）。
// 结果结构（实测 2026-10-24）：<a class="iusc" ... m="{&quot;purl&quot;:...,&quot;murl&quot;:...,&quot;turl&quot;:...,&quot;t&quot;:...}">
//   purl=来源页 URL，murl=媒体 URL，turl=缩略图 URL，t=标题。属性值经 HTML 实体转义，需先解码再 JSON.parse。
import { BaseProvider, AVAILABILITY, genericParse, normalizeItems, trackedRequest } from './base.mjs';
import { decodeEntities } from '../lib/http/parse-html.mjs';

const IUSC_TAG_RE = /<a\b[^>]*\bclass="[^"]*\biusc\b[^"]*"[^>]*>/gi;
const M_ATTR_RE = /\bm="([^"]*)"/i;

function parseIusc(html) {
  const text = String(html || '');
  const raw = [];
  for (const m of text.matchAll(IUSC_TAG_RE)) {
    const attr = M_ATTR_RE.exec(m[0]);
    if (!attr) continue;
    let data;
    try {
      data = JSON.parse(decodeEntities(attr[1]));
    } catch {
      continue; // 单个条目解析失败不影响其余条目
    }
    if (!data || typeof data.purl !== 'string' || !data.purl) continue;
    raw.push({
      url: data.purl,
      title: data.t || data.desc || null,
      thumb_url: data.turl || data.murl || null,
    });
  }
  return raw;
}

export function parseBingHtml(html, baseUrl) {
  const structured = normalizeItems(parseIusc(html));
  if (structured.length) return structured;
  // 兜底：结果页改版时退化为锚点提取，交给上层判 PARSE_ERROR 或零命中。
  return genericParse(html, baseUrl, 20);
}

export class BingProvider extends BaseProvider {
  constructor() {
    super({
      id: 'bing',
      label: 'Bing 图片',
      entryUrl: 'https://www.bing.com/visualsearch',
      manualEntryLabel: '打开 Bing 视觉搜索上传页',
      availability: {
        deeplink: AVAILABILITY.VERIFIED,
        upload: AVAILABILITY.UNVERIFIED,
        bridge: AVAILABILITY.VERIFIED,
      },
      notes: 'deeplink 已验证；upload 端点（api/v3/searchbyimage 等三个候选）未验证，默认关闭',
    });
  }

  buildDeeplink(imageUrl) {
    const encoded = encodeURIComponent(imageUrl);
    return `https://www.bing.com/images/searchbyimage/upload?imgurl=${encoded}&cbir=sbi`;
  }

  parse(html, baseUrl) {
    return parseBingHtml(html, baseUrl);
  }

  // 覆盖基类：处理 upload 端点的 3xx 跳转到结果页。
  async searchByDeeplink(ctx, imageUrl) {
    let url = this.buildDeeplink(imageUrl);
    if (!url) {
      return { ok: false, errorCode: 'PARSE_ERROR', errorMessage: '深链形态不可用' };
    }
    for (let hop = 0; hop < 2; hop += 1) {
      const res = await trackedRequest(ctx, url, { method: 'GET' });
      if (!res.ok) {
        return { ok: false, errorCode: res.errorCode, errorMessage: res.errorMessage, httpStatus: res.status };
      }
      const location = res.headers?.location;
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).href;
        continue;
      }
      const items = this.parse(res.body, url);
      if (!items.length) {
        return {
          ok: false,
          errorCode: 'PARSE_ERROR',
          errorMessage: 'Bing 返回 200 但未找到 iusc 结果项（可能触发验证或改版）',
          httpStatus: res.status,
          latencyMs: res.latencyMs,
        };
      }
      return { ok: true, items, requestUrl: url, httpStatus: res.status, latencyMs: res.latencyMs };
    }
    return { ok: false, errorCode: 'PARSE_ERROR', errorMessage: 'Bing 重定向次数超过限制' };
  }
}

export function createBingProvider() {
  return new BingProvider();
}
