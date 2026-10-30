// 真机端到端：用修复后的 Bing 适配器代码 + 真实代理，验证深链能一路跟到结果页。
// 这是「一直都是手动上传」的直接验收点——只有这里跑出 items，才算真的修好。
//
//   node scripts/probe/22-bing-live.mjs [图片公网 URL]
//
// 不传 URL 时用已上传到 frames 分支的探针图。
import { loadConfig } from '../../server/lib/config.mjs';
import { createBingProvider } from '../../server/providers/bing.mjs';
import { createMetrics } from '../../server/providers/base.mjs';

const DEFAULT_IMAGE =
  'https://raw.githubusercontent.com/Inceptionlrz/reverse-video-search/frames/probe/1793378226362.jpg';

const imageUrl = process.argv[2] || DEFAULT_IMAGE;
const cfg = loadConfig(process.env);
const provider = createBingProvider();
const metrics = createMetrics();
const ctx = { cfg, providerId: provider.id, metrics };

console.log(`代理: ${cfg.proxy || '(无)'}`);
console.log(`超时: connect=${cfg.net.connectTimeoutMs} tls=${cfg.net.tlsTimeoutMs} ttfb=${cfg.net.ttfbTimeoutMs} total=${cfg.net.totalTimeoutMs}`);
console.log(`图片: ${imageUrl}`);
console.log(`深链: ${provider.buildDeeplink(imageUrl)}`);
console.log('');

const started = Date.now();
const res = await provider.searchByDeeplink(ctx, imageUrl);
const elapsed = Date.now() - started;

console.log(`耗时: ${elapsed}ms  出站请求数: ${metrics.providerRequests[provider.id]}`);
console.log(`结果: ok=${res.ok} httpStatus=${res.httpStatus ?? '-'} items=${res.items?.length ?? 0}`);
if (res.ok) {
  console.log(`落地页: ${res.requestUrl}`);
  for (const it of (res.items || []).slice(0, 5)) {
    console.log(`  #${it.rank} ${it.title || '(无标题)'} -> ${it.url}`);
  }
} else {
  console.log(`失败: code=${res.errorCode} message=${res.errorMessage}`);
}
process.exit(res.ok ? 0 : 1);
