// 引擎适配器抽象：契约、归一化与出站请求计数。
// 所有引擎适配器必须实现本文件定义的 Provider 形态；出站一律走 trackedRequest。
import { request } from '../lib/http/request.mjs';
import { decodeEntities, extractCandidates, isSafeHttpUrl } from '../lib/http/parse-html.mjs';

// 接入方式可用性三态：verified（实测可用）/ unverified（形态存在但未实测）/ unavailable（实测不可用）
export const AVAILABILITY = { VERIFIED: 'verified', UNVERIFIED: 'unverified', UNAVAILABLE: 'unavailable' };

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

  // 子类实现：把结果页 HTML 解析为归一化条目；空数组不代表失败。
  parse(html, baseUrl) {
    return [];
  }

  // 子类实现：multipart 直传（实验性，默认关闭）。
  async searchByUpload(ctx) {
    return { ok: false, errorCode: 'UPLOAD_REJECTED', errorMessage: '该引擎未实现直传' };
  }

  // 共享：deeplink 一次请求。调用方负责把失败落入降级链。
  async searchByDeeplink(ctx, imageUrl) {
    const url = this.buildDeeplink(imageUrl);
    if (!url) {
      return { ok: false, errorCode: 'PARSE_ERROR', errorMessage: '该引擎的深链形态不可用' };
    }
    const res = await trackedRequest(ctx, url, { method: 'GET' });
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
      zeroResult: items.length === 0,
    };
  }
}

// 通用兜底解析：锚点 + 标题（零结构假设，命中率低于引擎专用解析）。
export function genericParse(html, baseUrl, limit = 20) {
  const { items } = extractCandidates(html, baseUrl, limit);
  return items.map((it) => ({ url: it.url, title: it.title, thumb_url: it.thumb_url, rank: it.rank }));
}

export { decodeEntities };
