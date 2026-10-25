// 测试共享基建：临时数据目录 + 离线配置 + 应用装配 + HTTP 客户端 + 数据夹具。
// 全部测试离线运行（RVS_OFFLINE=1）：任何需要外网的路径直接降级为 manual，不发出站请求。
// 说明：测试代码同样不出现 fetch(——HTTP 客户端用 node:http 手写，保持全仓库零 fetch 约定可被 grep 校验。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/lib/config.mjs';
import { createApp } from '../server/app.mjs';
import { spawnBinary } from '../server/lib/media/probe.mjs';
import { newFrameId, newTaskId } from '../server/lib/ids.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DHASH_POOL = [
  '0f1e2d3c4b5a6978',
  '8a7b6c5d4e3f2019',
  '13579bdf2468ace0',
  'ff00ff00ff00ff00',
  '0123456789abcdef',
  'deadbeefdeadbeef',
  'c0ffee11c0ffee11',
  'a5a5a5a5a5a5a5a5',
];

let dhashCursor = 0;

function nextDhash() {
  const value = DHASH_POOL[dhashCursor % DHASH_POOL.length];
  dhashCursor += 1;
  return value;
}

// 离线配置：临时数据目录 + 离线开关 + 随机端口 + 压缩引擎节流（测试提速，不影响被测逻辑）。
export function makeOfflineConfig(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rvs-test-'));
  const cfg = loadConfig(
    {
      RVS_DATA_DIR: path.join(tmp, 'data'),
      RVS_OFFLINE: '1',
      RVS_LOG_LEVEL: 'error',
      RVS_PORT: '0',
      RVS_ENGINE_MIN_INTERVAL_MS: '50',
      ...extra,
    },
    REPO_ROOT,
  );
  return { cfg, tmp };
}

export async function startApp(cfg) {
  const app = await createApp({ config: cfg });
  await app.listen();
  return app;
}

// node:http 版 HTTP 客户端：返回 { status, json, text, buffer, headers }。
export function httpCall(port, method, pathName, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathName,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          Connection: 'close',
          ...(extraHeaders || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // 非 JSON 响应（如 CSV）保持原文
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json, buffer });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function makeClient(port) {
  return {
    get: (p, extraHeaders) => httpCall(port, 'GET', p, undefined, extraHeaders),
    post: (p, body, extraHeaders) => httpCall(port, 'POST', p, body ?? {}, extraHeaders),
    patch: (p, body, extraHeaders) => httpCall(port, 'PATCH', p, body ?? {}, extraHeaders),
    put: (p, body, extraHeaders) => httpCall(port, 'PUT', p, body ?? {}, extraHeaders),
    del: (p) => httpCall(port, 'DELETE', p),
  };
}

// 三段结构差异明显的测试源（smptehdbars / rgbtestsrc / testsrc 各 2 秒）：
// 段内静止 → 帧内去重分组；段间差异大 → 不同组；段边界 → scene 检测有素材。
export async function makeTestVideo(dir, name = 'fixture.mp4') {
  const file = path.join(dir, name);
  const args = [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'smptehdbars=s=320x180:d=2:r=10',
    '-f', 'lavfi', '-i', 'rgbtestsrc=s=320x180:d=2:r=10',
    '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=2:r=10',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]',
    '-pix_fmt', 'yuv420p',
    '-t', '6',
    file, '-y',
  ];
  await spawnBinary('ffmpeg', args, { timeoutMs: 60000 });
  return file;
}

// 轮询等待条件成立，超时抛错（避免测试静默通过）。
export async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---- 数据夹具：直接写仓储，绕开 ffmpeg，专注验证服务层行为 ----

export async function seedTask(app, overrides = {}) {
  const id = overrides.id || newTaskId();
  const now = Date.now();
  const row = {
    id,
    created_at: now,
    source_type: 'file',
    source_name: 'fixture.mp4',
    display_name: 'fixture.mp4',
    source_path: path.join(os.tmpdir(), 'rvs-fixture-source.mp4'),
    source_url: null,
    status: 'frames_ready',
    phase: 'frames_ready',
    duration_ms: 6000,
    width: 320,
    height: 180,
    codec: 'h264',
    extract_mode: 'interval',
    max_frames: 12,
    scene_threshold: 0.25,
    ffmpeg_error: null,
    created_ms: now,
    updated_ms: now,
    frames_done: 0,
    analyses_done: 0,
    analyses_total: 0,
    confirmed: 0,
    deleted_at: null,
    ...overrides,
  };
  await app.ctx.repos.tasks.insert(row);
  return id;
}

export async function seedFrame(app, taskId, overrides = {}) {
  const id = overrides.id || newFrameId();
  const seq = overrides.seq ?? 1;
  const row = {
    id,
    task_id: taskId,
    seq,
    file_name: `${String(seq).padStart(3, '0')}_${seq * 1500}.jpg`,
    file_path: path.join(os.tmpdir(), 'rvs-fixture-frame.jpg'),
    url_path: `/frames/${taskId}/fixture.jpg`,
    time_ms: seq * 1500,
    width: 320,
    height: 180,
    dhash: nextDhash(),
    dup_group: 1,
    is_duplicate: 0,
    enabled: 1,
    ...overrides,
    id,
    task_id: taskId,
  };
  await app.ctx.repos.frames.insertMany([row]);
  return id;
}

// 帧 × 引擎的一次执行夹具。frameId 必须唯一（UNIQUE(frame_id, provider)）。
export async function seedAnalysis(app, taskId, overrides = {}) {
  const id = overrides.id || `rvs_a_fixture_${Math.random().toString(36).slice(2, 12)}`;
  const frameId = overrides.frame_id || `rvs_f_fixture_${Math.random().toString(36).slice(2, 12)}`;
  const now = Date.now();
  const row = {
    id,
    task_id: taskId,
    frame_id: frameId,
    provider: overrides.provider || 'bing',
    attempt_mode: null,
    hit_source: null,
    status: 'failed',
    error_code: 'NETWORK_ERROR',
    error_message: 'fixture',
    request_url: null,
    http_status: null,
    latency_ms: null,
    started_ms: null,
    finished_ms: now,
    degradation_log: null,
    manual_path: null,
    manual_url: null,
    created_ms: now,
    ...overrides,
    id,
    task_id: taskId,
    frame_id: frameId,
  };
  await app.ctx.repos.analyses.insert(row);
  return id;
}

export function zeroOutbound(app) {
  const provider = Object.values(app.metrics.providerRequests).every((n) => n === 0);
  const imagehost = Object.values(app.metrics.imagehostRequests).every((n) => n === 0);
  return provider && imagehost;
}

// 等待任务下所有 analysis 进入终态。
export async function waitForAnalysesSettled(api, taskId, timeoutMs = 30000) {
  const terminal = new Set(['succeeded', 'zero_result', 'manual', 'failed', 'cancelled']);
  return waitFor(
    async () => {
      const res = await api.get(`/api/tasks/${taskId}/analyses`);
      const items = res.json?.data?.items || [];
      return items.length > 0 && items.every((a) => terminal.has(a.status)) ? items : null;
    },
    { timeoutMs, intervalMs: 150, label: `analyses settled for ${taskId}` },
  );
}

// 只等待指定 analysis 进入终态（夹具里可能含非生产状态，不能用来卡全集合）。
export async function waitForIdsSettled(api, taskId, ids, timeoutMs = 30000) {
  const terminal = new Set(['succeeded', 'zero_result', 'manual', 'failed', 'cancelled']);
  const target = new Set(ids);
  return waitFor(
    async () => {
      const res = await api.get(`/api/tasks/${taskId}/analyses`);
      const items = (res.json?.data?.items || []).filter((a) => target.has(a.id));
      return items.length === target.size && items.every((a) => terminal.has(a.status)) ? items : null;
    },
    { timeoutMs, intervalMs: 150, label: `analyses drained for ${taskId}` },
  );
}

export async function waitForTaskStatus(api, taskId, status, timeoutMs = 60000) {
  return waitFor(
    async () => {
      const res = await api.get(`/api/tasks/${taskId}`);
      const current = res.json?.data?.task?.status;
      return current === status ? res.json.data.task : null;
    },
    { timeoutMs, intervalMs: 200, label: `task ${taskId} status=${status}` },
  );
}

/* ===== 最小 DOM 桩（供视图层渲染测试使用） =====
 *
 * 前端是零依赖原生模块，本仓库不装 jsdom。为了能在 Node 里真正执行一遍渲染函数
 * （而不是只测纯逻辑），这里手搓一个极小 DOM：只实现 h()/svgEl()/icon()/
 * applyProps()/appendChildren() 实际用到的那几个 API。
 *
 * 它明确不是浏览器替身：没有布局、样式计算、事件冒泡、焦点管理。它能保证的是
 * 「渲染路径不抛错、节点与文案按预期产出」；不能保证的是「在浏览器里好看」。
 * 用它的测试不要越界去断言视觉表现。
 */
class StubNodeBase {
  constructor() { this.children = []; this.attrs = {}; this.parent = null; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parent = null; return child; }
  remove() { if (this.parent) this.parent.removeChild(this); return this; }
  get firstChild() { return this.children[0] || null; }
}

class StubElement extends StubNodeBase {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = String(tag).toLowerCase();
    this.style = {};
    this.dataset = {};
    this.textContent = '';
    const attrs = this.attrs;
    this.classList = {
      add: (...names) => {
        const set = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        attrs.class = [...set].join(' ');
      },
    };
  }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  addEventListener() {}
  removeEventListener() {}
  remove() { if (this.parent) this.parent.removeChild(this); return this; }
  focus() {}

  /** 极小选择器匹配：仅支持 tag、.class、#id、tag[attr] 与逗号组合，够 dom.js 用。 */
  static matches(node, sel) {
    const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
    return parts.some((p) => {
      if (p.startsWith('#')) return node.attrs && node.attrs.id === p.slice(1);
      if (p.startsWith('.')) return String((node.attrs && node.attrs.class) || '').split(/\s+/).includes(p.slice(1));
      const attr = p.match(/^([\w-]+)\[([\w-]+)\]$/);
      if (attr) return node.tagName === attr[1] && node.attrs && node.attrs[attr[2]] !== undefined;
      return node.tagName === p;
    });
  }

  querySelector(sel) {
    let found = null;
    const walk = (n) => {
      if (found) return;
      for (const c of n.children) {
        if (c.nodeType !== 1) continue;
        if (StubElement.matches(c, sel)) { found = c; return; }
        walk(c);
      }
    };
    walk(this);
    return found;
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.nodeType !== 1) continue;
        if (StubElement.matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

class StubText extends StubNodeBase {
  constructor(text) { super(); this.nodeType = 3; this.textContent = String(text); }
}

/** 装上 document / Node 两个全局，返回卸载函数。 */
export function installDomStub() {
  const prevDoc = globalThis.document;
  const prevNode = globalThis.Node;
  const prevHtmlEl = globalThis.HTMLElement;
  const prevLocation = globalThis.location;
  // body 必须是真节点：modal()/toast() 都往它上面 appendChild，
  // 用 no-op 对象会让渲染结果无处可查（断言会假绿）。
  const body = new StubElement('body');
  globalThis.document = {
    createElement: (tag) => new StubElement(tag),
    createElementNS: (_ns, tag) => new StubElement(tag),
    createTextNode: (text) => new StubText(text),
    getElementById: () => null,
    // 任何选择器都返回 body：modal()/toast()/popover() 的 root 容器因此就是 body，
    // 断言可以直接 stubFindAll(document.body, ...) 往下找。这不是选择器引擎，
    // 只是让"挂载点"有一个可查的落点。
    querySelector: () => body,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
    body,
  };
  globalThis.Node = StubNodeBase;
  // dom.js 里有 `x instanceof HTMLElement` 判断，无此全局会直接 ReferenceError
  globalThis.HTMLElement = StubElement;
  // safeHttpUrl 用 location.origin 解析相对地址；缺了它会把所有外链判成 null，
  // 于是"打开发引擎上传页"按钮静默消失——正是本测试要防的那类假绿。
  globalThis.location = { origin: 'http://127.0.0.1:4173', href: 'http://127.0.0.1:4173/' };
  return () => {
    globalThis.document = prevDoc;
    globalThis.Node = prevNode;
    globalThis.HTMLElement = prevHtmlEl;
    globalThis.location = prevLocation;
  };
}

/** 深度拼接一棵桩 DOM 的文本（含 text 属性与 textContent），用于断言渲染产出。 */
export function stubText(node, out = []) {
  if (!node) return out.join('');
  if (node.nodeType === 3) out.push(node.textContent);
  if (node.nodeType === 1) {
    // class 走 classList.add 落到 attrs.class；text 走 textContent。两者都收，
    // 免得断言漏掉其中一条路径。
    if (node.textContent) out.push(node.textContent);
  }
  for (const child of node.children || []) stubText(child, out);
  return out.join('');
}

/** 按 class 名收集子树中的节点（含自身）。 */
export function stubFindAll(node, cls, out = []) {
  if (!node || node.nodeType !== 1) return out;
  if (String((node.attrs && node.attrs.class) || '').split(/\s+/).includes(cls)) out.push(node);
  for (const child of node.children || []) stubFindAll(child, cls, out);
  return out;
}
