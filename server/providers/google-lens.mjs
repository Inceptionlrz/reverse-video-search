// Google Lens 适配器。
//
// 实测结论（2026-10-30 五个候选端点复测，证据 scripts/probe/24-lens-recheck.mjs
// 与 out-24-*.html）：
//
//   1) Lens 系四个端点（searchbyimage?image_url= 带/不带 hl、lens uploadbyurl
//      带/不带 hl）→ 303/302 跳到 www.google.com，200，但都是同一个纯 JS 应用外壳：
//      <noscript> 跳 /httpservice/retry/enablejs，/url?q= 0、data-ved 0、
//      AF_initDataCallback 0，约 94KB。HTTP 层没有数据。
//
//   2) 经典端点 https://www.google.com/search?tbs=sbi:<enc> → 200，但返回的是
//      **Google 首页**（title 为 "Google"，可见正文只有搜索框与页脚），
//      217KB 里 data-ved 36 个却没有任何视觉匹配区块、唯一外链是页脚 about.google。
//      即 tbs=sbi 参数已被 Google 忽略。
//
//   3) 用 Playwright 真开浏览器访问 lens uploadbyurl：图片 URL **确实被接受了**
//      （落地 URL 带 vsdim=576,1024 与 lns_surface=26），但随即被跳到
//      /sorry/index —— "Our systems have detected unusual traffic"。
//      即当前代理出口 IP 被 Google 风控，浏览器这条路在这台机器上也不可靠。
//
// 结论：Google 这条线在当前环境下无法纯 HTTP 自动化。deeplink / bridge 保持 unavailable，
// 但失败码不再是 PARSE_ERROR（那会把人引向"改解析规则"），而是 ENGINE_NO_HTTP_RESULT。
//
// 能做的改进：Lens 接受**图片 URL**，所以只要帧有一个公网直链，就能构造一个
// "已带图片"的链接，用户在浏览器点开即是结果页——省掉手动上传文件这一步。
// 见 buildManualDeeplink()。注意这仍可能被 /sorry 风控拦，故文案里说清。
import { BaseProvider, AVAILABILITY } from './base.mjs';

const UNAVAILABLE_REASON =
  'Google 实测无法纯 HTTP 检索：Lens 系端点返回 JS 应用外壳（无数据），经典 tbs=sbi 端点已被忽略返回首页；浏览器直开还会撞 Google 风控 /sorry（复测 2026-10-30，证据 scripts/probe/24-lens-recheck.mjs）';

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

  // 手动深链：不参与自动解析，只作为 manual 模式的入口交给用户在浏览器打开。
  // Lens 接受 url 参数（实测落地 URL 带 vsdim，说明图被取到了），
  // 所以有公网直链时用户点开就是结果页，不必自己拖文件。
  buildManualDeeplink(imageUrl) {
    if (!imageUrl) return null;
    return `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
  }

  parse() {
    return [];
  }

  async searchByDeeplink() {
    // 双保险：即使被误调用，也不发起网络请求。
    return { ok: false, errorCode: 'ENGINE_NO_HTTP_RESULT', errorMessage: UNAVAILABLE_REASON };
  }
}

export function createGoogleLensProvider() {
  return new GoogleLensProvider();
}

export { UNAVAILABLE_REASON };
