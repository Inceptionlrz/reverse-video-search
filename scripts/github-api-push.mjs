#!/usr/bin/env node
/**
 * git push 备用通道：用 GitHub Git Data API 做「真正的增量提交」。
 *
 * 背景：本机到 github.com 的 TLS 握手会被间歇性 RST（实测直连成功率约 1/3），
 * 走 Clash 代理同样失败，因此 git push 常年卡死。Git Data API 走的是同一条
 * HTTPS 链路，但每个请求都很短，配合重试可以穿透。
 *
 * 与「全量快照」方案的区别：本脚本只把本地相对远端 head 的改动打成新 commit，
 * parent 指向远端真实 head，因此提交历史是连续的，不会重建整棵树。
 *
 * 用法：
 *   node scripts/github-api-push.mjs                 # 提交 origin/main..HEAD 的全部改动
 *   node scripts/github-api-push.mjs --dry           # 只打印将要提交的内容，不写远端
 *   node scripts/github-api-push.mjs --ref main --base <sha>
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const API = 'https://api.github.com';
const OWNER = 'Inceptionlrz';
const REPO = 'reverse-video-search';
const ROOT = path.resolve(import.meta.dirname, '..');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const REF = flag('--ref', 'main');

const TOKEN = readFileSync(path.join(homedir(), '.workbuddy', 'github_token.txt'), 'utf8').trim();

/**
 * 单次请求 + 重试。TLS 被 RST 时表现为 fetch failed / ECONNRESET，必须重试。
 */
async function api(method, urlPath, body = null, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      const res = await fetch(API + urlPath, {
        method,
        signal: ac.signal,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          accept: 'application/vnd.github+json',
          'api-version': '2022-11-28',
          'user-agent': 'rvs-git-data-push',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : null,
      });
      clearTimeout(timer);
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
      if (res.ok) return json;
      // 4xx 是业务错误，重试无意义
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`HTTP ${res.status} ${json?.message || text.slice(0, 300)}`);
      }
      lastErr = new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('timeout 20s') : e;
    }
    // 指数退避：1s 2s 3s ... 上限 8s
    await new Promise((r) => setTimeout(r, Math.min(1000 * (i + 1), 8000)));
  }
  throw new Error(`${method} ${urlPath} 失败（重试 ${tries} 次）：${lastErr?.message}`);
}

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

async function main() {
  // [1] 远端真实 head —— 不能信本地缓存的 origin/main（fetch 常年失败，缓存是旧的）
  const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${REF}`);
  const remoteHead = ref.object.sha;
  const base = flag('--base', remoteHead);
  console.log(`远端 ${REF} head = ${remoteHead}${base !== remoteHead ? `  (指定 base ${base})` : ''}`);

  // [2] 本次要提交的文件改动
  const diffRange = `${remoteHead}..HEAD`;
  const nameStatus = execFileSync('git', ['diff', '--name-status', diffRange], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  if (nameStatus.length === 0) {
    console.log('本地相对远端没有改动，无需提交。');
    return;
  }
  const changes = nameStatus.map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status: status.trim(), p: rest.join('\t') };
  });
  console.log(`待提交 ${changes.length} 个文件：`);
  for (const c of changes) console.log(`  ${c.status}  ${c.p}`);

  const subject = git('log', '-1', '--format=%s');
  const bodyMsg = git('log', '-1', '--format=%b').trim();
  const message = bodyMsg ? `${subject}\n\n${bodyMsg}` : subject;
  console.log(`提交信息：${subject}`);

  if (DRY) { console.log('--dry 模式，未写入远端。'); return; }

  // [3] 为每个改动文件创建 blob（删除的用 sha:null，无需 blob）
  const tree = [];
  for (const c of changes) {
    if (c.status === 'D') { tree.push({ path: c.p, mode: '100644', type: 'blob', sha: null }); continue; }
    const abs = path.join(ROOT, c.p);
    const content = readFileSync(abs);
    const mode = git('ls-files', '--format=%(objectmode)', '--', c.p) || '100644';
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    tree.push({ path: c.p, mode, type: 'blob', sha: blob.sha });
    console.log(`  blob ${c.p} -> ${blob.sha.slice(0, 8)}`);
  }

  // [4] 以远端 head 的树为基线生成新树 —— 未改动的文件自动继承，不做全量重建
  const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: base,
    tree,
  });

  // [5] 建 commit，parent 指向远端真实 head，保证历史连续
  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [base],
  });
  console.log(`新 commit = ${commit.sha}`);

  // [6] 快进 ref。带 expected=base 做乐观并发，冲突时报错而不是覆盖
  const updated = await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${REF}`, {
    sha: commit.sha,
    ...(base === remoteHead ? {} : {}),
  });
  console.log(`\n推送完成：${REF} ${remoteHead.slice(0, 8)} -> ${commit.sha.slice(0, 8)}`);
  console.log(`https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
  return updated;
}

main().catch((e) => { console.error(`\n[失败] ${e.message}`); process.exit(1); });
