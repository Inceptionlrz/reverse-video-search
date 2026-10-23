// Google Lens 适配器。
// 实测结论（2026-10-24，证据 scripts/probe/lens.html 与 out-G2_GET_lens_uploadbyurl.txt）：
//   GET https://lens.google.com/uploadbyurl?url=<encoded> 返回 HTTP 200，
//   但 title 恒为 "Google Search"，页面无任何 Lens 结果结构（lens × 0 / uploadbyurl × 0）。
// 即：200 状态码不代表功能可用。ARCHITECTURE §4.2 中"deeplink 已验证可用"的结论据此**已作废**。
// 本适配器将 deeplink 标记为 unavailable：编排层会跳过 deeplink 与基于 deeplink 的 bridge，
// **不消耗任何注定为空的网络请求**，直接走 manual 指引。upload（v3/upload）端点字段名未验证，默认关闭。
import { BaseProvider, AVAILABILITY } from './base.mjs';

const UNAVAILABLE_REASON =
  'Google Lens 深链实测不可用：uploadbyurl 返回 200 但页面无 Lens 结果结构（实测 2026-10-24）';

export class GoogleLensProvider extends BaseProvider {
  constructor() {
    super({
      id: 'google_lens',
      label: 'Google Lens',
      entryUrl: 'https://lens.google.com/',
      manualEntryLabel: '打开 Google Lens 上传页',
      availability: {
        deeplink: AVAILABILITY.UNAVAILABLE,
        upload: AVAILABILITY.UNVERIFIED,
        bridge: AVAILABILITY.UNAVAILABLE,
      },
      notes: UNAVAILABLE_REASON,
    });
  }

  // 深链不可用：返回 null，编排层据此跳过 deeplink 与 bridge 两级。
  buildDeeplink() {
    return null;
  }

  parse() {
    return [];
  }

  async searchByDeeplink() {
    // 双保险：即使被误调用，也不发起网络请求。
    return { ok: false, errorCode: 'PARSE_ERROR', errorMessage: UNAVAILABLE_REASON };
  }
}

export function createGoogleLensProvider() {
  return new GoogleLensProvider();
}

export { UNAVAILABLE_REASON };
