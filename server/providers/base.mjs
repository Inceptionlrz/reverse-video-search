// 引擎适配器抽象：契约、归一化与出站请求计数。
// 所有引擎适配器必须实现本文件定义的 Provider 形态；出站一律走 trackedRequest。
import { request } from '../lib/http/request.mjs';
import { decodeEntities, extractCandidates, isSafeHttpUrl } from '../lib/http/parse-html.mjs';

// 接入方式可用性三态：verified（实测可用）/ unverified（形态存在但未实测）/ unavailable（实测不可用）
export const AVAILABILITY = { VERIFIED: 'verified', UNVERIFIED: 'unverified', UNAVAILABLE: 'unavailable' };

// 深链 3xx 跟随上限。request.mjs 不自动跟随，由 searchByDeeplink 手动跟。
// Bing detailv2 深链实测需 3 跳（302→301→302→200），故留到 4 跳。
export const MAX_REDIRECT_HOPS = 4;

// 归一化结果项：url 必填（来源页），thumb_url 可空，rank 从 1 开始。
export function normalizeItem(raw, index) {
  const url = typeof raw?.url === 'string' ? raw.url.trim() : '';
  if (!url || !isSafeHttpUrl(url)) return null;
  const title = typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 200) : null;
  const thumb = typeof raw?.thumb_url === 'string' && isSafeHttpUrl(raw.thumb_url.trim()) ? raw.thumb_url.trim() : null;
  return { url, title, thumb_url: thumb, rank: Number.isFinite(raw?.rank) ? raw.rank : index + 1 };
}

export function normalizeItems(list) {
  const out = [];
  let auto = 0;
  for (const raw of list || []) {
    auto += 1;
    const item = normalizeItem(raw, auto);
    if (item) out.push(item);
  }
  return out.map((it, i) => ({ ...it, rank: i + 1 }));
}

// 出站请求统一入口：每次真实网络调用在此计数（SPEC §14 验收项：provider 停用后请求计数必须为 0）。
export async function trackedRequest(ctx, url, options = {}) {
  const providerId = ctx?.providerId;
  const metrics = ctx?.metrics;
  if (metrics && providerId) {
    metrics.providerRequests[providerId] = (metrics.providerRequests[providerId] || 0) + 1;
  }
  // 测试缝：ctx.transport 存在时改走注入的实现，不发真实网络请求。
  // request.mjs 固定用 https.request，本地起 http 服务打不到它；
  // 而 3xx 跟随这类分支只有能注入才测得动（否则只能写"源码里有没有这行"的假断言）。
  // 返回值形态与 request() 一致：{ ok, status, headers, body, latencyMs, errorCode, errorMessage }。
  if (typeof ctx?.transport === 'function') {
    return ctx.transport(url, options);
  }
  const res = await request(url, {
    config: ctx?.cfg,
    proxy: ctx?.cfg?.proxy,
    cancelToken: ctx?.cancelToken,
    agent: ctx?.agent,
    ...options,
  });
  return res;
}

export function createMetrics() {
  return { providerRequests: {}, imagehostRequests: {} };
}

// 手工模式指引：打开引擎上传入口页（不需要图片 URL），并把帧文件路径交回调用方。
export function manualFallback(provider, frame) {
  return {
    mode: 'manual',
    provider,
    frame_id: frame?.id ?? null,
    frame_path: frame?.file_path ?? null,
    entry_url: provider.entryUrl,
    entry_label: provider.manualEntryLabel,
  };
}

// 适配器基类：只提供共享结构，不提供任何搜索实现。
export class BaseProvider {
  constructor({ id, label, entryUrl, manualEntryLabel, availability, notes = '' }) {
    this.id = id;
    this.label = label;
    this.entryUrl = entryUrl;
    this.manualEntryLabel = manualEntryLabel || `打开 ${label} 以图搜图`;
    this.availability = availability; // { deeplink, upload, bridge }
    this.notes = notes;
  }

  // 子类实现：由公网图片 URL 构造深链；返回 null 表示该方式不可用。
  buildDeeplink(imageUrl) {
    return null;
  }

  // 子类实现：构造"给人在浏览器里打开"的链接，不参与自动解析。
  // 用于那些 HTTP 层拿不到结果、但浏览器里能直接出结果的引擎（Google Lens 实测如此）：
  // 有公网图片 URL 时，用户点开即是结果页，省掉手动上传文件这一步。
  // 返回 null 表示没有这一形态，manual 回落到普通上传页。
  buildManualDeeplink(imageUrl) {
    return null;
  }

  // 子类实现：把结果页 HTML 解析为归一化条目；空数组不代表失败。
  parse(html, baseUrl) {
    return [];
  }

  // 子类实现：multipart 直传（实验性，默认关闭）。
  async searchByUpload(ctx) {
    return { ok: false, errorCode: 'UPLOAD_REJECTED', errorMessage: '该引擎未实现直传' };
  }

  // 共享：deeplink 请求 + 手动跟随 3xx。调用方负责把失败落入降级链。
  // ⚠️ request.mjs 不自动跟随 3xx，且 3xx 不是 res.ok：跟随分支必须写在 !res.ok 判定之前。
  //   若顺序颠倒，302 会先被 !res.ok 拦下返回，跟随代码变成永不执行的死代码
  //   （Bing 曾因此永远死在第一跳，界面却报"页面结构无法解析"）。
  async searchByDeeplink(ctx, imageUrl) {
    let url = this.buildDeeplink(imageUrl);
    if (!url) {
      return { ok: false, errorCode: 'PARSE_ERROR', errorMessage: '该引擎的深链形态不可用' };
    }
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
      const res = await trackedRequest(ctx, url, { method: 'GET' });
      const location = res.headers?.location;
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).href;
        continue;
      }
      if (!res.ok) {
        return { ok: false, errorCode: res.errorCode, errorMessage: res.errorMessage, httpStatus: res.status };
      }
      const items = this.parse(res.body, url);
      if (!items.length) {
        return {
          ok: false,
          errorCode: 'PARSE_ERROR',
          errorMessage: '引擎返回 200 但无法提取结果结构（响应格式可能已变化）',
          httpStatus: res.status,
          latencyMs: res.latencyMs,
        };
      }
      return {
        ok: true,
        items,
        requestUrl: url,
        httpStatus: res.status,
        latencyMs: res.latencyMs,
      };
    }
    return {
      ok: false,
      errorCode: 'PARSE_ERROR',
      errorMessage: `深链重定向次数超过限制（${MAX_REDIRECT_HOPS} 跳）`,
    };
  }
}

// 通用兜底解析：锚点 + 标题（零结构假设，命中率低于引擎专用解析）。
export function genericParse(html, baseUrl, limit = 20) {
  const { items } = extractCandidates(html, baseUrl, limit);
  return items.map((it) => ({ url: it.url, title: it.title, thumb_url: it.thumb_url, rank: it.rank }));
}

export { decodeEntities };
