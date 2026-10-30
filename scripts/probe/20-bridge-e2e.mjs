// 桥接端到端实测（走项目自己的模块，不复制一份逻辑）：
//   上传帧到图床 → 拿到公网 URL → 校验确实是图片 → 喂引擎深链 → 数结果。
//
// 只有整条链路跑通才能说"桥接是活的"：
//   - 单测"上传成功"没意义——图床常返回 HTML 预览页而非图片本体（tmpfiles 实测如此），
//     引擎拿这种 URL 只能得到空结果，而上层只看到"上传成功"；
//   - 只看深链也不行——深链 200 不代表跟到了结果页（302 不跟随就是死在第一跳）。
//
// 用法：
//   RVS_GITHUB_TOKEN=xxx RVS_GITHUB_REPO=owner/repo node scripts/probe/20-bridge-e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../server/lib/config.mjs';
import { createMetrics } from '../../server/providers/base.mjs';
import { createGitHubHost } from '../../server/providers/imagehost/github.mjs';
import { createBingProvider } from '../../server/providers/bing.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const cfg = loadConfig(process.env);
const host = createGitHubHost();
const provider = createBingProvider();
const metrics = createMetrics();
const ctx = { cfg, metrics };

if (!host.configured()) {
  console.error('未配置 GitHub 图床：需要 RVS_GITHUB_TOKEN 与 RVS_GITHUB_REPO（owner/repo）');
  process.exit(2);
}

const buf = fs.readFileSync(path.join(HERE, 'test-realframe.jpg'));
console.log(`图床: ${host.label}  分支: ${host.branch}`);
console.log(`引擎: ${provider.label}  代理: ${cfg.proxy || '(无)'}`);
console.log('');

// 1) 上传
const up = await host.upload({ ...ctx, providerId: host.id }, { buffer: buf, filename: `probe-${Date.now()}.jpg` });
console.log(`[1] 上传: ok=${up.ok} status=${up.httpStatus ?? '-'}`);
if (!up.ok) {
  console.log(`    失败: ${up.errorCode} — ${up.errorMessage}`);
  process.exit(1);
}
console.log(`    直链: ${up.url}`);

// 2) 深链检索（这一步同时覆盖"链接真能被引擎取到"——取不到就没有结果）
const started = Date.now();
const res = await provider.searchByDeeplink({ ...ctx, providerId: provider.id }, up.url);
console.log(`[2] 检索: ok=${res.ok} status=${res.httpStatus ?? '-'} items=${res.items?.length ?? 0} 耗时=${Date.now() - started}ms`);
if (!res.ok) {
  console.log(`    失败: ${res.errorCode} — ${res.errorMessage}`);
  process.exit(1);
}
console.log(`    落地页: ${res.requestUrl}`);
for (const it of (res.items || []).slice(0, 5)) {
  console.log(`      #${it.rank} ${it.title || '(无标题)'} -> ${it.url}`);
}

console.log('');
console.log(`出站请求数: 图床=${metrics.imagehostRequests[host.id] ?? 0} 引擎=${metrics.providerRequests[provider.id] ?? 0}`);
console.log(res.items?.length ? '桥接链路可用' : '桥接链路通了但零结果');
process.exit(res.items?.length ? 0 : 1);
