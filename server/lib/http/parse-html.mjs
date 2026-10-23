// 结果页片段提取：受限正则，不是完整 HTML 解析器。
// 只抽取"链接 + 标题 + 缩略图引用"三元组，绝不落盘第三方正文内容。
const HREF_RE = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi;
const IMG_RE = /<img[^>]+src=["']([^"']+)["']/gi;
const TITLE_RE = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i;
const STRIP_TAG_RE = /<[^>]+>/g;
const ENTITIES = [
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&nbsp;/g, ' '],
];

export function decodeEntities(text) {
  let out = String(text || '');
  for (const [re, ch] of ENTITIES) out = out.replace(re, ch);
  return out.replace(/\s+/g, ' ').trim();
}

export function stripTags(text) {
  return decodeEntities(String(text || '').replace(STRIP_TAG_RE, ' '));
}

export function pageTitle(html) {
  const m = TITLE_RE.exec(String(html || ''));
  return m ? decodeEntities(m[1]) : null;
}

const UNSAFE_SCHEME = /^(javascript|data|vbscript|file):/i;

export function isSafeHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeUrl(value, base) {
  if (!value) return null;
  let raw = String(value).trim();
  if (UNSAFE_SCHEME.test(raw)) return null;
  if (raw.startsWith('//')) raw = `https:${raw}`;
  if (raw.startsWith('/') && base) {
    try {
      raw = new URL(raw, base).href;
    } catch {
      return null;
    }
  }
  if (!isSafeHttpUrl(raw)) return null;
  return raw;
}

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_eid|yclid|_ga|ref_|spm|from)/i;
const IGNORE_HOST_HINT = /(google|bing|yandex|microsoft|msn|live|akamai|gstatic|googleapis|doubleclick)/i;

// 规范化：小写 host、去尾斜杠、去追踪参数、去 hash。用于跨帧/跨引擎去重（EARS 16）。
export function canonicalizeUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  const keep = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!TRACKING_PARAMS.test(k)) keep.push([k, v]);
  }
  const search = new URLSearchParams();
  for (const [k, v] of keep.sort((a, b) => (a[0] < b[0] ? -1 : 1))) search.append(k, v);
  u.search = search.toString();
  let path = u.pathname.replace(/\/+$/, '');
  if (path === '') path = '/';
  return `${u.protocol}//${u.host}${path}${u.search ? `?${u.search}` : ''}`;
}

export function domainOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// 从结果页 HTML 提取候选。返回 {items, strategy}。items 为空不代表失败，
// 由调用方结合 http 状态判定 PARSE_ERROR 还是 ZERO_RESULT。
export function extractCandidates(html, baseUrl, limit = 20) {
  const text = String(html || '');
  const seen = new Set();
  const items = [];
  const thumbs = [];
  for (const m of text.matchAll(IMG_RE)) {
    const src = normalizeUrl(m[1], baseUrl);
    if (src) thumbs.push(src);
  }
  let rank = 0;
  for (const m of text.matchAll(HREF_RE)) {
    const href = normalizeUrl(m[1], baseUrl);
    if (!href) continue;
    const canonical = canonicalizeUrl(href);
    if (!canonical) continue;
    if (IGNORE_HOST_HINT.test(new URL(href).hostname)) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const title = stripTags(m[2]).slice(0, 200);
    if (!title) continue;
    rank += 1;
    items.push({
      url: href,
      canonical_url: canonical,
      domain: domainOf(href),
      title: title || null,
      snippet: null,
      thumb_url: thumbs.length ? thumbs[(rank - 1) % thumbs.length] : null,
      rank,
    });
    if (items.length >= limit) break;
  }
  return { items, strategy: 'anchor_href_v1' };
}
