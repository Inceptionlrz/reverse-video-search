// Google Lens 适配器。
// 实测结论（2026-10-25 复测，证据 scripts/probe/18-lens-cookie.mjs 与 out-H-*.html）：
//
//   1) POST https://lens.google.com/v3/upload（multipart，字段名 encoded_image）
//      → HTTP 303 + Location 指向 https://www.google.com/search?...&udm=26&lns_surface=26...
//      **上传被接受**。那个 303 地址就是 Lens 网页端上传成功后的结果页地址，
//      字段名 encoded_image 是对的。
//
//   2) 跟进该 303（带 cookie jar 与不带各测一遍）→ 200，但页面是纯 JS 应用外壳：
//      <noscript> 跳 /httpservice/retry/enablejs；AF_initDataCallback 0 命中、
//      /url?q= 0 命中、data-ved 0 命中；外壳内没有任何数据端点
//      （无 script src、无 batchexecute、无 rpcids）。结果全部由客户端 JS 渲染，
//      HTTP 层拿不到。
//
//   3) uploadbyurl 同理：200 + 同一个 JS 外壳。它"没有结果"不是因为端点失效，
//      而是撞同一堵 JS 渲染墙。
//
// 结论：Lens 无法用纯 HTTP 自动化，除非引入完整浏览器（Playwright 之类）——那与本项目
// 零运行时依赖的设计冲突，且逆向其内部 RPC 极脆弱、易静默失效。故 deeplink / bridge
// 均标 unavailable，编排层直接走 manual；手动成本由 manual-runbook.view.js 的
// 剪贴板写入与 File 拖放压低。
//
// 更正记录：本文件此前把原因写成"uploadbyurl 返回 200 但页面无 Lens 结果结构"，
// 并据此判定 upload 不可用。那是**误诊**——真实原因是结果页为 JS 渲染，
// 与走 upload 还是 uploadbyurl 无关。上传端点本身是通的。
import { BaseProvider, AVAILABILITY } from './base.mjs';

const UNAVAILABLE_REASON =
  'Google Lens 深链实测不可用：结果页由浏览器 JS 渲染，HTTP 层无数据可解析（复测 2026-10-25，证据 scripts/probe/18-lens-cookie.mjs）';

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
