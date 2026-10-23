// Yandex 适配器。deeplink 形态（E-08）：
//   GET https://yandex.com/images/search?rpt=imageview&url=<encoded>&cbir_page=similar
// 实测（2026-10-24，scripts/probe/out-yandex-full.html，546 KB）：HTTP 200 但结果由客户端渲染，
// 服务端 HTML 中 serp-item 仅 3 处且均来自内联 JS，无可解析的结果结构。
// 因此本适配器的定位是"尝试 + 如实降级"：解析策略按优先级尝试，全部落空即返回 PARSE_ERROR，
// 由上层降级到 bridge / manual，不伪装成功。
import { BaseProvider, AVAILABILITY, genericParse, normalizeItems } from './base.mjs';
import { decodeEntities } from '../lib/http/parse-html.mjs';

// 策略一：serp-item 的 data-bem JSON（Yandex BEM 形态）。
const SERP_ITEM_RE = /<(?:div|li)\b[^>]*\bclass="[^"]*\bserp-item\b[^"]*"[^>]*>/gi;
const DATA_BEM_RE = /\bdata-bem="([^"]*)"/i;

// 策略二：内联 JSON 中的 img_href / alt / href 三元组（probe 17 实测形态）。
const IMG_HREF_BLOB_RE = /\{[^{}]*?"img_href":"([^"]+)"[^{}]*?\}/g;

function fromDataBem(html) {
  const raw = [];
  for (const m of String(html || '').matchAll(SERP_ITEM_RE)) {
    const attr = DATA_BEM_RE.exec(m[0]);
    if (!attr) continue;
    let bem;
    try {
      bem = JSON.parse(decodeEntities(attr[1]));
    } catch {
      continue;
    }
    const item = bem?.serpItem ?? bem;
    const url = item?.href || item?.url || item?.source?.url;
    if (typeof url !== 'string' || !url) continue;
    raw.push({ url, title: item?.alt || item?.title || null, thumb_url: item?.img_href || item?.thumb || null });
  }
  return raw;
}

function fromImgHrefBlobs(html) {
  const raw = [];
  const text = String(html || '');
  for (const m of text.matchAll(IMG_HREF_BLOB_RE)) {
    const blob = m[0];
    const pick = (key) => {
      const hit = new RegExp(`"${key}":"([^"]*)"`).exec(blob);
      return hit ? hit[1] : null;
    };
    const url = pick('href') || pick('url');
    if (!url) continue;
    raw.push({ url, title: pick('alt') || pick('title'), thumb_url: pick('img_href') });
  }
  return raw;
}

export function parseYandexHtml(html, baseUrl) {
  const strategies = [fromDataBem(html), fromImgHrefBlobs(html)];
  for (const raw of strategies) {
    const items = normalizeItems(raw);
    if (items.length) return items;
  }
  return genericParse(html, baseUrl, 20);
}

export class YandexProvider extends BaseProvider {
  constructor() {
    super({
      id: 'yandex',
      label: 'Yandex 图片',
      entryUrl: 'https://yandex.com/images/',
      manualEntryLabel: '打开 Yandex 以图搜图',
      availability: {
        deeplink: AVAILABILITY.UNVERIFIED,
        upload: AVAILABILITY.UNVERIFIED,
        bridge: AVAILABILITY.UNVERIFIED,
      },
      notes: 'deeplink 返回 200 但结果为客户端渲染，服务端无结构；上传形态（upfile）未验证',
    });
  }

  buildDeeplink(imageUrl) {
    const encoded = encodeURIComponent(imageUrl);
    return `https://yandex.com/images/search?rpt=imageview&url=${encoded}&cbir_page=similar`;
  }

  parse(html, baseUrl) {
    return parseYandexHtml(html, baseUrl);
  }
}

export function createYandexProvider() {
  return new YandexProvider();
}
