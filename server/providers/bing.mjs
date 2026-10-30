// Bing 适配器。deeplink 已验证可用。复跑方式：
//   node scripts/probe/22-bing-live.mjs
// 实测（2026-10-30）：HTTP 200、35 条 iusc 结果、4 次请求（3 跳 + 落地页）、1663ms。
// 深链形态：
//   GET https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:<encoded>
//   链式跳转 302→301→302→200 后落到结果页（实测需 3 跳，故上限设 4）。
//   ⚠️ 旧形态 images/searchbyimage/upload?imgurl=&cbir=sbi 跟随到 cn.bing.com 是 404，已弃用。
//   ⚠️ request.mjs 不自动跟随 3xx，且 3xx 不是 res.ok：跟随分支必须写在 !res.ok 判定之前，
//      否则 302 会先被 !res.ok 拦下返回，跟随代码变成永不执行的死代码。
// 结果结构（实测 2026-10-24）：<a class="iusc" ... m="{&quot;purl&quot;:...,&quot;murl&quot;:...,&quot;turl&quot;:...,&quot;t&quot;:...}">
//   purl=来源页 URL，murl=媒体 URL，turl=缩略图 URL，t=标题。属性值经 HTML 实体转义，需先解码再 JSON.parse。
import { BaseProvider, AVAILABILITY, genericParse, normalizeItems } from './base.mjs';
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
    return `https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:${encoded}`;
  }

  parse(html, baseUrl) {
    return parseBingHtml(html, baseUrl);
  }
  // 不覆盖 searchByDeeplink：基类的 3xx 跟随循环已覆盖 Bing 的 3 跳链路。
}

export function createBingProvider() {
  return new BingProvider();
}
